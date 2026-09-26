//! The `derived` expression language — a tiny **total**, statically-typed
//! sub-language (a Pluto cell). Totality + no user-defined recursion ⇒ it always
//! terminates and never throws, which is a precondition of the renderer's
//! "no crash" guarantee (a non-`loaded` dataset / empty aggregate becomes the
//! renderer's `unavailable`, not a panic).
//!
//! The checker parses an expression, type-checks it against the declared signal
//! & column types, and reports the referenced signals/datasets so the caller can
//! build the reactive DAG (S7) and the reference set (S3). If it type-checks
//! here, the renderer's evaluator has a total interpretation for it.
//!
//! Grammar (precedence-climbing):
//!   expr    := or
//!   or      := and (`||` and)*
//!   and     := cmp (`&&` cmp)*
//!   cmp     := add ((`==`|`!=`|`<`|`<=`|`>`|`>=`) add)*
//!   add     := mul ((`+`|`-`) mul)*
//!   mul     := unary ((`*`|`/`|`%`) unary)*
//!   unary   := (`-`|`!`) unary | postfix
//!   postfix := primary (`.`ident | `[`expr`]`)*
//!   primary := number | string | `true` | `false` | ident (`(`args`)`)? | `(`expr`)`
//!
//! Lexical rules match the renderer's lexer (`web/.../interactive-view/expr.ts`)
//! exactly: whitespace is ASCII space/tab/CR/LF only, and a numeric literal must
//! be finite (`1e999` is rejected on both sides). Both parsers bound expression
//! nesting at [`MAX_EXPR_DEPTH`], so an accepted expression can never exhaust
//! the evaluator's stack.
//!
//! Columns are vectorized over one row set. A column remembers the dataset
//! (row set) it came from, and combining columns from two different row sets is
//! rejected outside an aggregate: the renderer lifts element-wise by row index,
//! so mixing `a.x + b.y` would silently pair unrelated rows.

use std::collections::{BTreeMap, BTreeSet};

use super::model::{ColumnType, SignalType};

/// The deepest expression nesting (parenthesised groups, unary chains, and
/// operator chains all count) the checker and the renderer accept.
pub const MAX_EXPR_DEPTH: usize = 64;

type Schema = BTreeMap<String, ColumnType>;

/// A type in the expression language. `Scalar` is a single value; `Column` is a
/// vectorized scalar bound to a dataset row set (identified by its origin key);
/// `Dataset` is a table with its schema and row-set origin; `Interval` is an
/// index-only pair from an interval signal.
#[derive(Debug, Clone, PartialEq)]
pub enum Ty {
    Scalar(S),
    Column(S, String),
    Dataset(Schema, String),
    Interval(S),
}

/// The scalar element kinds. `Integer` collapses into `Num`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum S {
    Num,
    Bool,
    Str,
    Temporal,
}

impl S {
    fn label(self) -> &'static str {
        match self {
            S::Num => "number",
            S::Bool => "boolean",
            S::Str => "string",
            S::Temporal => "temporal",
        }
    }
    fn of_column(c: ColumnType) -> S {
        match c {
            ColumnType::Number | ColumnType::Integer => S::Num,
            ColumnType::String => S::Str,
            ColumnType::Boolean => S::Bool,
            ColumnType::Temporal => S::Temporal,
        }
    }
}

/// The `ColumnType` a `with`-computed column of scalar kind `S` gets — the
/// inverse of `S::of_column` (a numeric expression yields a `Number` column).
fn column_type_of(s: S) -> ColumnType {
    match s {
        S::Num => ColumnType::Number,
        S::Bool => ColumnType::Boolean,
        S::Str => ColumnType::String,
        S::Temporal => ColumnType::Temporal,
    }
}

impl Ty {
    fn describe(&self) -> String {
        match self {
            Ty::Scalar(s) => s.label().to_string(),
            Ty::Column(s, _) => format!("column<{}>", s.label()),
            Ty::Dataset(..) => "dataset".to_string(),
            Ty::Interval(s) => format!("interval<{}>", s.label()),
        }
    }
    /// The scalar element, if this reads as a scalar or a column of one.
    fn elem(&self) -> Option<S> {
        match self {
            Ty::Scalar(s) | Ty::Column(s, _) => Some(*s),
            _ => None,
        }
    }
    /// The row-set origin of a column, `None` for anything else.
    fn column_origin(&self) -> Option<&str> {
        match self {
            Ty::Column(_, origin) => Some(origin),
            _ => None,
        }
    }
}

/// The single row set shared by every column among `tys`, or `None` when all
/// of them are scalars. Columns from different row sets cannot be combined.
fn shared_origin(tys: &[&Ty]) -> Result<Option<String>, ExprError> {
    let mut origin: Option<&str> = None;
    for t in tys {
        if let Some(o) = t.column_origin() {
            match origin {
                None => origin = Some(o),
                Some(prev) if prev == o => {}
                Some(prev) => {
                    return Err(ExprError::new(format!(
                        "cannot combine columns from different datasets or row sets (`{}` and `{}`); \
                         aggregate one side first (e.g. `mean(…)`)",
                        origin_label(prev),
                        origin_label(o)
                    )));
                }
            }
        }
    }
    Ok(origin.map(str::to_string))
}

/// A readable name for a row-set origin key (a dataset name, or the base of a
/// `filter(…)` chain).
fn origin_label(origin: &str) -> String {
    match origin.strip_prefix("filter(") {
        Some(rest) => {
            let base: String = rest.chars().take_while(|c| *c != '|').collect();
            format!("filter({base}, …)")
        }
        None => origin.to_string(),
    }
}

fn wrap(s: S, origin: Option<String>) -> Ty {
    match origin {
        Some(o) => Ty::Column(s, o),
        None => Ty::Scalar(s),
    }
}

/// Parse a strict ISO-8601 temporal value to UTC milliseconds since the epoch:
/// `YYYY-MM-DD`, optionally followed by `T` (or a space) `HH:MM[:SS[.fff…]]`
/// and an optional `Z` / `±HH:MM` / `±HHMM` offset. A value without an offset
/// reads as UTC. Calendar-invalid dates (`2024-02-30`) are rejected.
///
/// This is the temporal grammar the renderer's `isoInstant` (expr.ts) shares:
/// two temporal values order chronologically through it, and anything else
/// orders as a plain string.
pub fn iso_instant(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = b.get(from..from + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(part.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let (y, m, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    if !at(4, b'-') || !at(7, b'-') || !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    let mut ms = days_from_civil(y, m, d) as f64 * 86_400_000.0;
    let mut pos = 10;
    if pos < b.len() {
        if !(at(10, b'T') || at(10, b' ')) || !at(13, b':') {
            return None;
        }
        let (h, mi) = (digits(11, 2)?, digits(14, 2)?);
        if h > 23 || mi > 59 {
            return None;
        }
        ms += (h * 3_600_000 + mi * 60_000) as f64;
        pos = 16;
        if at(pos, b':') {
            let sec = digits(17, 2)?;
            if sec > 59 {
                return None;
            }
            ms += (sec * 1000) as f64;
            pos = 19;
            if at(pos, b'.') {
                let start = pos + 1;
                let end = b[start..]
                    .iter()
                    .position(|c| !c.is_ascii_digit())
                    .map_or(b.len(), |off| start + off);
                if end == start {
                    return None;
                }
                let frac: f64 = format!("0.{}", &s[start..end]).parse().ok()?;
                ms += frac * 1000.0;
                pos = end;
            }
        }
        if at(pos, b'Z') {
            pos += 1;
        } else if at(pos, b'+') || at(pos, b'-') {
            let sign = if at(pos, b'+') { 1 } else { -1 };
            let oh = digits(pos + 1, 2)?;
            let colon = usize::from(at(pos + 3, b':'));
            let om = digits(pos + 3 + colon, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            ms -= (sign * (oh * 3_600_000 + om * 60_000)) as f64;
            pos += 5 + colon;
        }
    }
    (pos == b.len()).then_some(ms)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 of a proleptic-Gregorian civil date (Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// What a caller needs to type-check an expression: the declared signal types
/// and dataset column schemas in scope.
pub struct ExprEnv<'a> {
    pub signals: &'a BTreeMap<String, SignalType>,
    pub datasets: &'a BTreeMap<String, BTreeMap<String, ColumnType>>,
}

/// The outcome of a successful check: the result type plus every signal and
/// dataset the expression touched (for the DAG + reference checks).
#[derive(Debug, Default)]
pub struct ExprResult {
    pub ty_desc: String,
    pub signal_refs: BTreeSet<String>,
    pub dataset_refs: BTreeSet<String>,
    /// When the expression evaluates to a *dataset* (e.g. `filter(sales, …)`),
    /// its inferred output schema — so a `derived` dataset can be registered and
    /// its columns validated downstream. `None` for a scalar-valued expression.
    pub dataset_columns: Option<BTreeMap<String, ColumnType>>,
}

/// A type/parse error, with a human message. (The expression is embedded in
/// JSON, so we report the message against the whole `derived` string rather than
/// a sub-span.)
#[derive(Debug, Clone)]
pub struct ExprError {
    pub message: String,
}

impl ExprError {
    fn new(m: impl Into<String>) -> Self {
        ExprError { message: m.into() }
    }
}

fn too_deep() -> ExprError {
    ExprError::new(format!(
        "expression nests deeper than {MAX_EXPR_DEPTH} levels; split it into derived signals"
    ))
}

/// Parse + type-check `src` against `env`. The single public entry point.
pub fn check(src: &str, env: &ExprEnv) -> Result<ExprResult, ExprError> {
    let tokens = lex(src)?;
    let mut p = Parser {
        tokens,
        pos: 0,
        nesting: 0,
    };
    let (ast, _) = p.parse_expr()?;
    if p.peek() != &Tok::Eof {
        return Err(ExprError::new(format!(
            "unexpected trailing input near {:?}",
            p.peek()
        )));
    }
    let mut refs = ExprResult::default();
    let mut tc = TypeChecker {
        env,
        refs: &mut refs,
    };
    let ty = tc.check(&ast, None)?;
    refs.ty_desc = ty.describe();
    if let Ty::Dataset(cols, _) = ty {
        refs.dataset_columns = Some(cols);
    }
    Ok(refs)
}

// ── lexer ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    True,
    False,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    AndAnd,
    OrOr,
    Bang,
    EqEq,
    BangEq,
    Gt,
    Ge,
    Lt,
    Le,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Dot,
    Eof,
}

fn lex(src: &str) -> Result<Vec<Tok>, ExprError> {
    let b = src.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i] as char;
        // Exactly the renderer's whitespace set — no Unicode spaces.
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            i += 1;
            continue;
        }
        match c {
            '+' => {
                out.push(Tok::Plus);
                i += 1;
            }
            '-' => {
                out.push(Tok::Minus);
                i += 1;
            }
            '*' => {
                out.push(Tok::Star);
                i += 1;
            }
            '/' => {
                out.push(Tok::Slash);
                i += 1;
            }
            '%' => {
                out.push(Tok::Percent);
                i += 1;
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            '[' => {
                out.push(Tok::LBracket);
                i += 1;
            }
            ']' => {
                out.push(Tok::RBracket);
                i += 1;
            }
            ',' => {
                out.push(Tok::Comma);
                i += 1;
            }
            '.' if !(i + 1 < b.len() && (b[i + 1] as char).is_ascii_digit()) => {
                out.push(Tok::Dot);
                i += 1;
            }
            '&' if i + 1 < b.len() && b[i + 1] == b'&' => {
                out.push(Tok::AndAnd);
                i += 2;
            }
            '|' if i + 1 < b.len() && b[i + 1] == b'|' => {
                out.push(Tok::OrOr);
                i += 2;
            }
            '!' if i + 1 < b.len() && b[i + 1] == b'=' => {
                out.push(Tok::BangEq);
                i += 2;
            }
            '!' => {
                out.push(Tok::Bang);
                i += 1;
            }
            '=' if i + 1 < b.len() && b[i + 1] == b'=' => {
                out.push(Tok::EqEq);
                i += 2;
            }
            '>' if i + 1 < b.len() && b[i + 1] == b'=' => {
                out.push(Tok::Ge);
                i += 2;
            }
            '>' => {
                out.push(Tok::Gt);
                i += 1;
            }
            '<' if i + 1 < b.len() && b[i + 1] == b'=' => {
                out.push(Tok::Le);
                i += 2;
            }
            '<' => {
                out.push(Tok::Lt);
                i += 1;
            }
            '\'' | '"' => {
                let quote = b[i];
                i += 1;
                let start = i;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
                if i >= b.len() {
                    return Err(ExprError::new("unterminated string literal"));
                }
                out.push(Tok::Str(src[start..i].to_string()));
                i += 1; // closing quote
            }
            c if c.is_ascii_digit() || c == '.' => {
                let start = i;
                while i < b.len()
                    && ((b[i] as char).is_ascii_digit()
                        || b[i] == b'.'
                        || b[i] == b'e'
                        || b[i] == b'E')
                {
                    i += 1;
                }
                let text = &src[start..i];
                let n: f64 = text
                    .parse()
                    .ok()
                    .filter(|n: &f64| n.is_finite())
                    .ok_or_else(|| ExprError::new(format!("bad number `{text}`")))?;
                out.push(Tok::Num(n));
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                while i < b.len() && ((b[i] as char).is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                out.push(match &src[start..i] {
                    "true" => Tok::True,
                    "false" => Tok::False,
                    id => Tok::Ident(id.to_string()),
                });
            }
            _ => {
                // Report the whole (possibly multi-byte) character.
                let ch = src[i..].chars().next().unwrap_or(c);
                return Err(ExprError::new(format!("unexpected character `{ch}`")));
            }
        }
    }
    out.push(Tok::Eof);
    Ok(out)
}

// ── parser (AST) ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Ast {
    Num(f64),
    Str(String),
    Bool(bool),
    Ident(String),
    Unary(UnOp, Box<Ast>),
    Bin(BinOp, Box<Ast>, Box<Ast>),
    Field(Box<Ast>, String),
    Index(Box<Ast>, Box<Ast>),
    Call(String, Vec<Ast>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum UnOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    And,
    Or,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// A parsed node plus its AST depth (a leaf is 1).
type Parsed = (Ast, usize);

/// The depth of a node over children of depth `child`, bounded by
/// [`MAX_EXPR_DEPTH`] so a long operator chain can't build an AST whose
/// traversal (or drop) would exhaust the stack.
fn node_depth(child: usize) -> Result<usize, ExprError> {
    let d = child + 1;
    if d > MAX_EXPR_DEPTH {
        Err(too_deep())
    } else {
        Ok(d)
    }
}

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
    /// Current recursion depth (parenthesised groups and unary chains nest the
    /// parser without necessarily adding AST depth).
    nesting: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos]
    }
    fn next(&mut self) -> Tok {
        let t = self.tokens[self.pos].clone();
        // `Eof` is sticky: never step past the terminator.
        if self.pos + 1 < self.tokens.len() {
            self.pos += 1;
        }
        t
    }
    fn eat(&mut self, t: &Tok) -> Result<(), ExprError> {
        if self.peek() == t {
            self.next();
            Ok(())
        } else {
            Err(ExprError::new(format!(
                "expected {:?}, found {:?}",
                t,
                self.peek()
            )))
        }
    }
    fn enter(&mut self) -> Result<(), ExprError> {
        self.nesting += 1;
        if self.nesting > MAX_EXPR_DEPTH {
            Err(too_deep())
        } else {
            Ok(())
        }
    }
    fn leave(&mut self) {
        self.nesting -= 1;
    }

    fn parse_expr(&mut self) -> Result<Parsed, ExprError> {
        self.enter()?;
        let r = self.parse_or();
        self.leave();
        r
    }
    fn bin(op: BinOp, (a, da): Parsed, (b, db): Parsed) -> Result<Parsed, ExprError> {
        Ok((
            Ast::Bin(op, Box::new(a), Box::new(b)),
            node_depth(da.max(db))?,
        ))
    }
    fn parse_or(&mut self) -> Result<Parsed, ExprError> {
        let mut lhs = self.parse_and()?;
        while self.peek() == &Tok::OrOr {
            self.next();
            let rhs = self.parse_and()?;
            lhs = Self::bin(BinOp::Or, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn parse_and(&mut self) -> Result<Parsed, ExprError> {
        let mut lhs = self.parse_cmp()?;
        while self.peek() == &Tok::AndAnd {
            self.next();
            let rhs = self.parse_cmp()?;
            lhs = Self::bin(BinOp::And, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn parse_cmp(&mut self) -> Result<Parsed, ExprError> {
        let mut lhs = self.parse_add()?;
        loop {
            let op = match self.peek() {
                Tok::EqEq => BinOp::Eq,
                Tok::BangEq => BinOp::Ne,
                Tok::Lt => BinOp::Lt,
                Tok::Le => BinOp::Le,
                Tok::Gt => BinOp::Gt,
                Tok::Ge => BinOp::Ge,
                _ => break,
            };
            self.next();
            let rhs = self.parse_add()?;
            lhs = Self::bin(op, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn parse_add(&mut self) -> Result<Parsed, ExprError> {
        let mut lhs = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => break,
            };
            self.next();
            let rhs = self.parse_mul()?;
            lhs = Self::bin(op, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn parse_mul(&mut self) -> Result<Parsed, ExprError> {
        let mut lhs = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Tok::Star => BinOp::Mul,
                Tok::Slash => BinOp::Div,
                Tok::Percent => BinOp::Mod,
                _ => break,
            };
            self.next();
            let rhs = self.parse_unary()?;
            lhs = Self::bin(op, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn parse_unary(&mut self) -> Result<Parsed, ExprError> {
        let op = match self.peek() {
            Tok::Minus => UnOp::Neg,
            Tok::Bang => UnOp::Not,
            _ => return self.parse_postfix(),
        };
        self.next();
        self.enter()?;
        let inner = self.parse_unary();
        self.leave();
        let (x, d) = inner?;
        Ok((Ast::Unary(op, Box::new(x)), node_depth(d)?))
    }
    fn parse_postfix(&mut self) -> Result<Parsed, ExprError> {
        let (mut e, mut depth) = self.parse_primary()?;
        loop {
            match self.peek() {
                Tok::Dot => {
                    self.next();
                    let name = match self.next() {
                        Tok::Ident(s) => s,
                        other => {
                            return Err(ExprError::new(format!(
                                "expected field name after `.`, found {other:?}"
                            )));
                        }
                    };
                    depth = node_depth(depth)?;
                    e = Ast::Field(Box::new(e), name);
                }
                Tok::LBracket => {
                    self.next();
                    let (idx, di) = self.parse_expr()?;
                    self.eat(&Tok::RBracket)?;
                    depth = node_depth(depth.max(di))?;
                    e = Ast::Index(Box::new(e), Box::new(idx));
                }
                _ => break,
            }
        }
        Ok((e, depth))
    }
    fn parse_primary(&mut self) -> Result<Parsed, ExprError> {
        match self.next() {
            Tok::Num(n) => Ok((Ast::Num(n), 1)),
            Tok::Str(s) => Ok((Ast::Str(s), 1)),
            Tok::True => Ok((Ast::Bool(true), 1)),
            Tok::False => Ok((Ast::Bool(false), 1)),
            Tok::LParen => {
                let e = self.parse_expr()?;
                self.eat(&Tok::RParen)?;
                Ok(e)
            }
            Tok::Ident(name) => {
                if self.peek() == &Tok::LParen {
                    self.next();
                    let mut args = Vec::new();
                    let mut deepest = 0;
                    if self.peek() != &Tok::RParen {
                        loop {
                            let (a, d) = self.parse_expr()?;
                            deepest = deepest.max(d);
                            args.push(a);
                            if self.peek() == &Tok::Comma {
                                self.next();
                            } else {
                                break;
                            }
                        }
                    }
                    self.eat(&Tok::RParen)?;
                    Ok((Ast::Call(name, args), node_depth(deepest)?))
                } else {
                    Ok((Ast::Ident(name), 1))
                }
            }
            other => Err(ExprError::new(format!("unexpected token {other:?}"))),
        }
    }
}

// ── type checker ─────────────────────────────────────────────────────────────

/// The column scope inside a `filter` predicate / `with` column: unqualified
/// names bind to `cols`, and every column they yield belongs to `origin`.
struct Scope<'s> {
    cols: &'s Schema,
    origin: &'s str,
}

struct TypeChecker<'a> {
    env: &'a ExprEnv<'a>,
    refs: &'a mut ExprResult,
}

impl<'a> TypeChecker<'a> {
    /// `scope` is the column scope introduced inside a `filter` predicate or a
    /// `with` column (unqualified column names bind to the dataset's columns,
    /// SQL-`WHERE`-style).
    fn check(&mut self, e: &Ast, scope: Option<&Scope>) -> Result<Ty, ExprError> {
        match e {
            Ast::Num(_) => Ok(Ty::Scalar(S::Num)),
            Ast::Str(_) => Ok(Ty::Scalar(S::Str)),
            Ast::Bool(_) => Ok(Ty::Scalar(S::Bool)),
            Ast::Ident(name) => self.check_ident(name, scope),
            Ast::Unary(op, x) => {
                let t = self.check(x, scope)?;
                match op {
                    UnOp::Neg => self.require_numlike(&t).map(|_| t),
                    UnOp::Not => match t.elem() {
                        Some(S::Bool) => Ok(t),
                        _ => Err(ExprError::new(format!(
                            "`!` needs a boolean, got {}",
                            t.describe()
                        ))),
                    },
                }
            }
            Ast::Bin(op, a, b) => self.check_bin(*op, a, b, scope),
            Ast::Field(base, field) => {
                // `dataset.column` on a named dataset: look the column up in
                // place instead of cloning the whole schema into a `Ty`.
                if let Ast::Ident(name) = base.as_ref()
                    && !scope.is_some_and(|s| s.cols.contains_key(name))
                    && !self.env.signals.contains_key(name)
                    && let Some(cols) = self.env.datasets.get(name)
                {
                    self.refs.dataset_refs.insert(name.clone());
                    return match cols.get(field) {
                        Some(ct) => Ok(Ty::Column(S::of_column(*ct), name.clone())),
                        None => Err(ExprError::new(format!(
                            "dataset `{name}` has no column `{field}`"
                        ))),
                    };
                }
                let t = self.check(base, scope)?;
                match t {
                    Ty::Dataset(cols, origin) => match cols.get(field) {
                        Some(ct) => Ok(Ty::Column(S::of_column(*ct), origin)),
                        None => Err(ExprError::new(format!("dataset has no column `{field}`"))),
                    },
                    other => Err(ExprError::new(format!(
                        "`.{field}` needs a dataset, got {}",
                        other.describe()
                    ))),
                }
            }
            Ast::Index(base, idx) => {
                let t = self.check(base, scope)?;
                match t {
                    Ty::Interval(s) => {
                        // Only literal 0 / 1 index an interval pair.
                        match idx.as_ref() {
                            Ast::Num(n) if *n == 0.0 || *n == 1.0 => Ok(Ty::Scalar(s)),
                            _ => Err(ExprError::new("interval index must be the literal 0 or 1")),
                        }
                    }
                    other => Err(ExprError::new(format!(
                        "indexing needs an interval signal, got {}",
                        other.describe()
                    ))),
                }
            }
            Ast::Call(name, args) => self.check_call(name, args, scope),
        }
    }

    fn check_ident(&mut self, name: &str, scope: Option<&Scope>) -> Result<Ty, ExprError> {
        if let Some(scope) = scope
            && let Some(ct) = scope.cols.get(name)
        {
            return Ok(Ty::Column(S::of_column(*ct), scope.origin.to_string()));
        }
        if let Some(st) = self.env.signals.get(name) {
            self.refs.signal_refs.insert(name.to_string());
            return match st {
                SignalType::Number | SignalType::Integer => Ok(Ty::Scalar(S::Num)),
                SignalType::Boolean => Ok(Ty::Scalar(S::Bool)),
                SignalType::String | SignalType::Enum => Ok(Ty::Scalar(S::Str)),
                SignalType::Temporal => Ok(Ty::Scalar(S::Temporal)),
                SignalType::IntervalNumber => Ok(Ty::Interval(S::Num)),
                SignalType::IntervalTemporal => Ok(Ty::Interval(S::Temporal)),
                SignalType::ArrayEnum => Err(ExprError::new(format!(
                    "signal `{name}` is array<enum> and cannot be used directly in an expression"
                ))),
            };
        }
        if let Some(cols) = self.env.datasets.get(name) {
            self.refs.dataset_refs.insert(name.to_string());
            return Ok(Ty::Dataset(cols.clone(), name.to_string()));
        }
        Err(ExprError::new(format!("unknown identifier `{name}`")))
    }

    fn check_bin(
        &mut self,
        op: BinOp,
        a: &Ast,
        b: &Ast,
        scope: Option<&Scope>,
    ) -> Result<Ty, ExprError> {
        let ta = self.check(a, scope)?;
        let tb = self.check(b, scope)?;
        let origin = shared_origin(&[&ta, &tb])?;
        match op {
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod => {
                self.require_numlike(&ta)?;
                self.require_numlike(&tb)?;
                Ok(wrap(S::Num, origin))
            }
            BinOp::And | BinOp::Or => {
                self.require_bool(&ta)?;
                self.require_bool(&tb)?;
                Ok(wrap(S::Bool, origin))
            }
            BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                // Numbers order numerically, temporals chronologically (the
                // renderer compares strict ISO-8601 values by instant), and
                // strings lexicographically. Mixed kinds never order.
                let sa = self.require_elem(&ta)?;
                let sb = self.require_elem(&tb)?;
                if sa != sb || sa == S::Bool {
                    return Err(ExprError::new(format!(
                        "cannot order {} and {}",
                        ta.describe(),
                        tb.describe()
                    )));
                }
                Ok(wrap(S::Bool, origin))
            }
            BinOp::Eq | BinOp::Ne => {
                let sa = self.require_elem(&ta)?;
                let sb = self.require_elem(&tb)?;
                if sa != sb {
                    return Err(ExprError::new(format!(
                        "cannot compare {} and {}",
                        ta.describe(),
                        tb.describe()
                    )));
                }
                Ok(wrap(S::Bool, origin))
            }
        }
    }

    fn check_call(
        &mut self,
        name: &str,
        args: &[Ast],
        scope: Option<&Scope>,
    ) -> Result<Ty, ExprError> {
        let arity = |n: usize| -> Result<(), ExprError> {
            if args.len() == n {
                Ok(())
            } else {
                Err(ExprError::new(format!(
                    "`{name}` takes {n} argument(s), got {}",
                    args.len()
                )))
            }
        };
        match name {
            "filter" => {
                arity(2)?;
                let ds = self.check(&args[0], scope)?;
                let (cols, base) = match ds {
                    Ty::Dataset(c, o) => (c, o),
                    other => {
                        return Err(ExprError::new(format!(
                            "`filter`'s first argument must be a dataset, got {}",
                            other.describe()
                        )));
                    }
                };
                // The predicate is checked with the dataset's columns in scope.
                let pred = {
                    let inner = Scope {
                        cols: &cols,
                        origin: &base,
                    };
                    self.check(&args[1], Some(&inner))?
                };
                if pred.elem() != Some(S::Bool) {
                    return Err(ExprError::new(format!(
                        "`filter`'s predicate must be boolean, got {}",
                        pred.describe()
                    )));
                }
                shared_origin(&[&Ty::Column(S::Bool, base.clone()), &pred])?;
                // A filter selects a new row set: its columns must not combine
                // with the unfiltered base's (or another filter's) columns.
                let origin = format!("filter({base}|{:?})", args[1]);
                Ok(Ty::Dataset(cols, origin))
            }
            "with" => {
                // with(ds, 'name', expr, 'name', expr, …) — append COMPUTED columns
                // to a dataset. Each expr is checked with the dataset's columns in
                // scope (unqualified refs bind, SQL-style), so it can combine
                // columns with signals: `with(bands, 'upper', mid + k*sigma)`
                // recomputes `upper` per row whenever the `k` signal changes. This
                // is what lets a widget RESHAPE a series (Bollinger bands widening
                // with k), not just filter it. Columns added earlier are in scope
                // for later ones, so a chain can build on itself. `with` keeps
                // the row set, so its columns share the base dataset's origin.
                if args.len() < 3 || args.len().is_multiple_of(2) {
                    return Err(ExprError::new(
                        "`with` takes a dataset then (name, expression) pairs: with(ds, 'col', expr, …)",
                    ));
                }
                let ds = self.check(&args[0], scope)?;
                let (mut cols, base) = match ds {
                    Ty::Dataset(c, o) => (c, o),
                    other => {
                        return Err(ExprError::new(format!(
                            "`with`'s first argument must be a dataset, got {}",
                            other.describe()
                        )));
                    }
                };
                let mut i = 1;
                while i + 1 < args.len() {
                    let name = match &args[i] {
                        Ast::Str(s) => s.clone(),
                        _ => {
                            return Err(ExprError::new(
                                "`with` column name must be a string literal",
                            ));
                        }
                    };
                    let t = {
                        let inner = Scope {
                            cols: &cols,
                            origin: &base,
                        };
                        self.check(&args[i + 1], Some(&inner))?
                    };
                    let s = t.elem().ok_or_else(|| {
                        ExprError::new(format!(
                            "`with` column `{name}` must be a scalar or column, got {}",
                            t.describe()
                        ))
                    })?;
                    shared_origin(&[&Ty::Column(s, base.clone()), &t])?;
                    cols.insert(name, column_type_of(s));
                    i += 2;
                }
                Ok(Ty::Dataset(cols, base))
            }
            "mean" | "sum" | "std" | "min" | "max" | "median" => {
                arity(1)?;
                let t = self.check(&args[0], scope)?;
                match t {
                    Ty::Column(S::Num, _) => Ok(Ty::Scalar(S::Num)),
                    other => Err(ExprError::new(format!(
                        "`{name}` aggregates a numeric column, got {}",
                        other.describe()
                    ))),
                }
            }
            "count" => {
                arity(1)?;
                let t = self.check(&args[0], scope)?;
                match t {
                    Ty::Column(..) | Ty::Dataset(..) => Ok(Ty::Scalar(S::Num)),
                    other => Err(ExprError::new(format!(
                        "`count` needs a column or dataset, got {}",
                        other.describe()
                    ))),
                }
            }
            "sqrt" | "abs" | "floor" | "ceil" => {
                arity(1)?;
                let t = self.check(&args[0], scope)?;
                self.require_numlike(&t)?;
                Ok(t)
            }
            "round" => {
                if args.len() != 1 && args.len() != 2 {
                    return Err(ExprError::new("`round` takes 1 or 2 arguments"));
                }
                let t = self.check(&args[0], scope)?;
                self.require_numlike(&t)?;
                if args.len() == 2 {
                    let d = self.check(&args[1], scope)?;
                    if d != Ty::Scalar(S::Num) {
                        return Err(ExprError::new(
                            "`round`'s digit count must be a scalar number",
                        ));
                    }
                }
                Ok(t)
            }
            "clamp" => {
                arity(3)?;
                let x = self.check(&args[0], scope)?;
                let lo = self.check(&args[1], scope)?;
                let hi = self.check(&args[2], scope)?;
                self.require_numlike(&x)?;
                // The renderer broadcasts only `x`; the bounds are scalars.
                if lo != Ty::Scalar(S::Num) || hi != Ty::Scalar(S::Num) {
                    return Err(ExprError::new("`clamp`'s bounds must be scalar numbers"));
                }
                Ok(x)
            }
            "if" => {
                arity(3)?;
                let c = self.check(&args[0], scope)?;
                self.require_bool(&c)?;
                let t = self.check(&args[1], scope)?;
                let f = self.check(&args[2], scope)?;
                let (se, sf) = (self.require_elem(&t)?, self.require_elem(&f)?);
                if se != sf {
                    return Err(ExprError::new(format!(
                        "`if` branches disagree: {} vs {}",
                        t.describe(),
                        f.describe()
                    )));
                }
                let origin = shared_origin(&[&c, &t, &f])?;
                Ok(wrap(se, origin))
            }
            other => Err(ExprError::new(format!("unknown function `{other}`"))),
        }
    }

    fn require_numlike(&self, t: &Ty) -> Result<(), ExprError> {
        match t.elem() {
            Some(S::Num) => Ok(()),
            _ => Err(ExprError::new(format!(
                "expected a number, got {}",
                t.describe()
            ))),
        }
    }
    fn require_bool(&self, t: &Ty) -> Result<(), ExprError> {
        match t.elem() {
            Some(S::Bool) => Ok(()),
            _ => Err(ExprError::new(format!(
                "expected a boolean, got {}",
                t.describe()
            ))),
        }
    }
    fn require_elem(&self, t: &Ty) -> Result<S, ExprError> {
        t.elem().ok_or_else(|| {
            ExprError::new(format!("expected a scalar/column, got {}", t.describe()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> (
        BTreeMap<String, SignalType>,
        BTreeMap<String, BTreeMap<String, ColumnType>>,
    ) {
        let mut signals = BTreeMap::new();
        signals.insert("rf".to_string(), SignalType::Number);
        signals.insert("band".to_string(), SignalType::IntervalNumber);
        signals.insert("tags".to_string(), SignalType::ArrayEnum);
        let mut cols = BTreeMap::new();
        cols.insert("day".to_string(), ColumnType::Integer);
        cols.insert("ret".to_string(), ColumnType::Number);
        let mut datasets = BTreeMap::new();
        datasets.insert("returns".to_string(), cols.clone());
        datasets.insert("sample".to_string(), cols);
        (signals, datasets)
    }

    fn chk(src: &str) -> Result<ExprResult, ExprError> {
        let (signals, datasets) = env();
        super::check(
            src,
            &ExprEnv {
                signals: &signals,
                datasets: &datasets,
            },
        )
    }

    #[test]
    fn sharpe_like_expr_types() {
        let r = chk("mean(returns.ret - rf) / std(returns.ret) * sqrt(252)").unwrap();
        assert_eq!(r.ty_desc, "number");
        assert!(r.signal_refs.contains("rf"));
        assert!(r.dataset_refs.contains("returns"));
    }

    #[test]
    fn filter_with_unqualified_columns_and_interval_index() {
        let r = chk("mean(filter(sample, day >= band[0] && day <= band[1]).value)");
        // `value` is not a column of `sample` → error naming the missing column.
        assert!(r.is_err());
        let r2 = chk("mean(filter(sample, day >= band[0] && day <= band[1]).ret)").unwrap();
        assert_eq!(r2.ty_desc, "number");
        assert!(r2.signal_refs.contains("band"));
        assert!(r2.dataset_refs.contains("sample"));
    }

    #[test]
    fn array_signal_rejected() {
        assert!(chk("tags").is_err());
    }

    #[test]
    fn unknown_identifier_rejected() {
        assert!(chk("nope + 1").is_err());
    }

    #[test]
    fn type_mismatch_rejected() {
        // comparing a string literal to a number column
        assert!(chk("returns.ret > 'x'").is_err());
    }

    #[test]
    fn aggregate_needs_column_not_scalar() {
        assert!(chk("mean(rf)").is_err());
    }

    #[test]
    fn with_computed_columns_type_and_schema() {
        // `with` appends columns combining existing columns with a signal — the
        // reshaping primitive (Bollinger bands widening with `rf`).
        let r = chk("with(returns, 'up', ret + rf, 'dn', ret - rf)").unwrap();
        assert_eq!(r.ty_desc, "dataset");
        let cols = r.dataset_columns.expect("with yields a dataset");
        assert_eq!(cols.get("up"), Some(&ColumnType::Number));
        assert_eq!(cols.get("dn"), Some(&ColumnType::Number));
        assert!(cols.contains_key("ret")); // originals preserved
        assert!(r.signal_refs.contains("rf"));
    }

    #[test]
    fn with_later_column_sees_earlier() {
        // a chained column can build on one added earlier in the same `with`.
        let r = chk("with(returns, 'a', ret * 2, 'b', a + 1)").unwrap();
        assert_eq!(r.ty_desc, "dataset");
    }

    #[test]
    fn with_bad_name_rejected() {
        // the column name must be a string literal, not an expression.
        assert!(chk("with(returns, ret, ret + 1)").is_err());
    }

    #[test]
    fn lexer_rejects_non_finite_numbers() {
        // `1e999` overflows to infinity; the renderer's lexer rejects it too.
        let e = chk("1e999 + 1").unwrap_err();
        assert!(e.message.contains("bad number"), "{}", e.message);
        assert!(chk("1e308 + 1").is_ok());
    }

    #[test]
    fn lexer_accepts_only_ascii_whitespace() {
        assert!(chk("rf +\t1\r\n").is_ok());
        // NBSP, ideographic space, and form feed are not whitespace here (nor
        // in the renderer's lexer).
        assert!(chk("rf\u{a0}+ 1").is_err());
        assert!(chk("rf\u{3000}+ 1").is_err());
        assert!(chk("rf\u{c}+ 1").is_err());
    }

    #[test]
    fn nesting_depth_is_bounded() {
        let ok = format!("{}1{}", "(".repeat(60), ")".repeat(60));
        assert!(chk(&ok).is_ok());
        let parens = format!("{}1{}", "(".repeat(70), ")".repeat(70));
        assert!(chk(&parens).unwrap_err().message.contains("nests deeper"));
        let unary = format!("{}1", "-".repeat(70));
        assert!(chk(&unary).unwrap_err().message.contains("nests deeper"));
        // A long left-associative chain builds a deep AST without recursing
        // the parser; it is bounded too.
        let chain = format!("1{}", " + 1".repeat(100_000));
        assert!(chk(&chain).unwrap_err().message.contains("nests deeper"));
        let short_chain = format!("1{}", " + 1".repeat(60));
        assert!(chk(&short_chain).is_ok());
    }

    #[test]
    fn columns_from_different_datasets_do_not_mix() {
        let e = chk("returns.ret + sample.ret").unwrap_err();
        assert!(e.message.contains("different datasets"), "{}", e.message);
        assert!(chk("returns.ret > sample.ret").is_err());
        assert!(chk("if(returns.ret > 0, sample.ret, 0)").is_err());
        // A filter is a new row set, even over the same base.
        assert!(chk("filter(returns, ret > 0).ret - returns.ret").is_err());
        // A filter predicate may not read another dataset's column.
        assert!(chk("filter(returns, sample.ret > 0)").is_err());
        assert!(chk("with(returns, 'x', sample.ret)").is_err());
        // Aggregating one side first is fine, and so is the same row set.
        assert!(chk("mean(returns.ret) - mean(sample.ret)").is_ok());
        assert!(chk("mean(returns.ret - returns.day)").is_ok());
        assert!(chk("mean(returns.ret - mean(sample.ret))").is_ok());
        assert!(chk("filter(returns, ret > mean(sample.ret))").is_ok());
        // `with` keeps its base's rows, so the new column combines with it.
        assert!(chk("mean(with(returns, 'x', ret * 2).x - returns.ret)").is_ok());
        // Identical filters select the same rows.
        assert!(chk("mean(filter(returns, ret > 0).ret - filter(returns, ret > 0).day)").is_ok());
    }

    /// Shared with `isoInstant` in the renderer's expr.test.ts — keep aligned.
    #[test]
    fn iso_instant_accepts_only_strict_iso_8601() {
        assert_eq!(iso_instant("1970-01-01"), Some(0.0));
        assert_eq!(iso_instant("2024-03-01"), Some(1_709_251_200_000.0));
        assert_eq!(iso_instant("2024-03-01T12:30"), Some(1_709_296_200_000.0));
        assert_eq!(
            iso_instant("2024-03-01 12:30:15"),
            Some(1_709_296_215_000.0)
        );
        assert_eq!(
            iso_instant("2024-03-01T12:30:15.5Z"),
            Some(1_709_296_215_500.0)
        );
        assert_eq!(
            iso_instant("2024-03-01T12:30+02:00"),
            Some(1_709_289_000_000.0)
        );
        assert_eq!(
            iso_instant("2024-03-01T12:30-0130"),
            Some(1_709_301_600_000.0)
        );
        assert_eq!(iso_instant("2024-02-29"), Some(1_709_164_800_000.0));
        assert_eq!(iso_instant("0099-01-01"), Some(-59_042_995_200_000.0));
        for bad in [
            "",
            "2024",
            "2024-1-01",
            "2024-13-01",
            "2023-02-29",
            "2024-04-31",
            "2024-03-01T",
            "2024-03-01T24:00",
            "2024-03-01T12:60",
            "2024-03-01Z",
            "2024-03-01T12:30:15.",
            "2024-03-01T12:30 ",
            "March 1, 2024",
            "Q1",
            "apple",
        ] {
            assert_eq!(iso_instant(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn clamp_bounds_must_be_scalar() {
        assert!(chk("mean(clamp(returns.ret, -1, 1))").is_ok());
        assert!(chk("mean(clamp(returns.ret, returns.ret, 1))").is_err());
    }
}
