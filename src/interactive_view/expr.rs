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

use std::collections::{BTreeMap, BTreeSet};

use super::model::{ColumnType, SignalType};

/// A type in the expression language. `Scalar` is a single value; `Column` is a
/// vectorized scalar bound to a dataset row; `Dataset` is a table; `Interval` is
/// an index-only pair from an interval signal.
#[derive(Debug, Clone, PartialEq)]
pub enum Ty {
    Scalar(S),
    Column(S),
    Dataset(BTreeMap<String, ColumnType>),
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

impl Ty {
    fn describe(&self) -> String {
        match self {
            Ty::Scalar(s) => s.label().to_string(),
            Ty::Column(s) => format!("column<{}>", s.label()),
            Ty::Dataset(_) => "dataset".to_string(),
            Ty::Interval(s) => format!("interval<{}>", s.label()),
        }
    }
    /// The scalar element, if this reads as a scalar or a column of one.
    fn elem(&self) -> Option<S> {
        match self {
            Ty::Scalar(s) | Ty::Column(s) => Some(*s),
            _ => None,
        }
    }
    fn is_column(&self) -> bool {
        matches!(self, Ty::Column(_))
    }
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

/// Parse + type-check `src` against `env`. The single public entry point.
pub fn check(src: &str, env: &ExprEnv) -> Result<ExprResult, ExprError> {
    let tokens = lex(src)?;
    let mut p = Parser { tokens, pos: 0 };
    let ast = p.parse_expr()?;
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
        if c.is_whitespace() {
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
                let n: f64 = src[start..i]
                    .parse()
                    .map_err(|_| ExprError::new(format!("bad number `{}`", &src[start..i])))?;
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
            other => return Err(ExprError::new(format!("unexpected character `{other}`"))),
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

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos]
    }
    fn next(&mut self) -> Tok {
        let t = self.tokens[self.pos].clone();
        self.pos += 1;
        t
    }
    fn eat(&mut self, t: &Tok) -> Result<(), ExprError> {
        if self.peek() == t {
            self.pos += 1;
            Ok(())
        } else {
            Err(ExprError::new(format!(
                "expected {:?}, found {:?}",
                t,
                self.peek()
            )))
        }
    }

    fn parse_expr(&mut self) -> Result<Ast, ExprError> {
        self.parse_or()
    }
    fn parse_or(&mut self) -> Result<Ast, ExprError> {
        let mut lhs = self.parse_and()?;
        while self.peek() == &Tok::OrOr {
            self.next();
            let rhs = self.parse_and()?;
            lhs = Ast::Bin(BinOp::Or, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn parse_and(&mut self) -> Result<Ast, ExprError> {
        let mut lhs = self.parse_cmp()?;
        while self.peek() == &Tok::AndAnd {
            self.next();
            let rhs = self.parse_cmp()?;
            lhs = Ast::Bin(BinOp::And, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn parse_cmp(&mut self) -> Result<Ast, ExprError> {
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
            lhs = Ast::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn parse_add(&mut self) -> Result<Ast, ExprError> {
        let mut lhs = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => break,
            };
            self.next();
            let rhs = self.parse_mul()?;
            lhs = Ast::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn parse_mul(&mut self) -> Result<Ast, ExprError> {
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
            lhs = Ast::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn parse_unary(&mut self) -> Result<Ast, ExprError> {
        match self.peek() {
            Tok::Minus => {
                self.next();
                Ok(Ast::Unary(UnOp::Neg, Box::new(self.parse_unary()?)))
            }
            Tok::Bang => {
                self.next();
                Ok(Ast::Unary(UnOp::Not, Box::new(self.parse_unary()?)))
            }
            _ => self.parse_postfix(),
        }
    }
    fn parse_postfix(&mut self) -> Result<Ast, ExprError> {
        let mut e = self.parse_primary()?;
        loop {
            match self.peek() {
                Tok::Dot => {
                    self.next();
                    let name = match self.next() {
                        Tok::Ident(s) => s,
                        other => {
                            return Err(ExprError::new(format!(
                                "expected field name after `.`, found {other:?}"
                            )))
                        }
                    };
                    e = Ast::Field(Box::new(e), name);
                }
                Tok::LBracket => {
                    self.next();
                    let idx = self.parse_expr()?;
                    self.eat(&Tok::RBracket)?;
                    e = Ast::Index(Box::new(e), Box::new(idx));
                }
                _ => break,
            }
        }
        Ok(e)
    }
    fn parse_primary(&mut self) -> Result<Ast, ExprError> {
        match self.next() {
            Tok::Num(n) => Ok(Ast::Num(n)),
            Tok::Str(s) => Ok(Ast::Str(s)),
            Tok::True => Ok(Ast::Bool(true)),
            Tok::False => Ok(Ast::Bool(false)),
            Tok::LParen => {
                let e = self.parse_expr()?;
                self.eat(&Tok::RParen)?;
                Ok(e)
            }
            Tok::Ident(name) => {
                if self.peek() == &Tok::LParen {
                    self.next();
                    let mut args = Vec::new();
                    if self.peek() != &Tok::RParen {
                        loop {
                            args.push(self.parse_expr()?);
                            if self.peek() == &Tok::Comma {
                                self.next();
                            } else {
                                break;
                            }
                        }
                    }
                    self.eat(&Tok::RParen)?;
                    Ok(Ast::Call(name, args))
                } else {
                    Ok(Ast::Ident(name))
                }
            }
            other => Err(ExprError::new(format!("unexpected token {other:?}"))),
        }
    }
}

// ── type checker ─────────────────────────────────────────────────────────────

struct TypeChecker<'a> {
    env: &'a ExprEnv<'a>,
    refs: &'a mut ExprResult,
}

impl<'a> TypeChecker<'a> {
    /// `local_cols` is the column scope introduced inside a `filter` predicate
    /// (unqualified column names bind to the dataset's columns, SQL-`WHERE`-style).
    fn check(
        &mut self,
        e: &Ast,
        local_cols: Option<&BTreeMap<String, ColumnType>>,
    ) -> Result<Ty, ExprError> {
        match e {
            Ast::Num(_) => Ok(Ty::Scalar(S::Num)),
            Ast::Str(_) => Ok(Ty::Scalar(S::Str)),
            Ast::Bool(_) => Ok(Ty::Scalar(S::Bool)),
            Ast::Ident(name) => self.check_ident(name, local_cols),
            Ast::Unary(op, x) => {
                let t = self.check(x, local_cols)?;
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
            Ast::Bin(op, a, b) => self.check_bin(*op, a, b, local_cols),
            Ast::Field(base, field) => {
                let t = self.check(base, local_cols)?;
                match t {
                    Ty::Dataset(cols) => match cols.get(field) {
                        Some(ct) => Ok(Ty::Column(S::of_column(*ct))),
                        None => Err(ExprError::new(format!("dataset has no column `{field}`"))),
                    },
                    other => Err(ExprError::new(format!(
                        "`.{field}` needs a dataset, got {}",
                        other.describe()
                    ))),
                }
            }
            Ast::Index(base, idx) => {
                let t = self.check(base, local_cols)?;
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
            Ast::Call(name, args) => self.check_call(name, args, local_cols),
        }
    }

    fn check_ident(
        &mut self,
        name: &str,
        local_cols: Option<&BTreeMap<String, ColumnType>>,
    ) -> Result<Ty, ExprError> {
        if let Some(cols) = local_cols {
            if let Some(ct) = cols.get(name) {
                return Ok(Ty::Column(S::of_column(*ct)));
            }
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
            return Ok(Ty::Dataset(cols.clone()));
        }
        Err(ExprError::new(format!("unknown identifier `{name}`")))
    }

    fn check_bin(
        &mut self,
        op: BinOp,
        a: &Ast,
        b: &Ast,
        local_cols: Option<&BTreeMap<String, ColumnType>>,
    ) -> Result<Ty, ExprError> {
        let ta = self.check(a, local_cols)?;
        let tb = self.check(b, local_cols)?;
        let vectorized = ta.is_column() || tb.is_column();
        let wrap = |s: S| {
            if vectorized {
                Ty::Column(s)
            } else {
                Ty::Scalar(s)
            }
        };
        match op {
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod => {
                self.require_numlike(&ta)?;
                self.require_numlike(&tb)?;
                Ok(wrap(S::Num))
            }
            BinOp::And | BinOp::Or => {
                self.require_bool(&ta)?;
                self.require_bool(&tb)?;
                Ok(wrap(S::Bool))
            }
            BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                let sa = self.require_elem(&ta)?;
                let sb = self.require_elem(&tb)?;
                if sa != sb || sa == S::Bool {
                    return Err(ExprError::new(format!(
                        "cannot order {} and {}",
                        ta.describe(),
                        tb.describe()
                    )));
                }
                Ok(wrap(S::Bool))
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
                Ok(wrap(S::Bool))
            }
        }
    }

    fn check_call(
        &mut self,
        name: &str,
        args: &[Ast],
        local_cols: Option<&BTreeMap<String, ColumnType>>,
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
                let ds = self.check(&args[0], local_cols)?;
                let cols = match ds {
                    Ty::Dataset(c) => c,
                    other => {
                        return Err(ExprError::new(format!(
                            "`filter`'s first argument must be a dataset, got {}",
                            other.describe()
                        )))
                    }
                };
                // The predicate is checked with the dataset's columns in scope.
                let pred = self.check(&args[1], Some(&cols))?;
                if pred.elem() != Some(S::Bool) {
                    return Err(ExprError::new(format!(
                        "`filter`'s predicate must be boolean, got {}",
                        pred.describe()
                    )));
                }
                Ok(Ty::Dataset(cols))
            }
            "mean" | "sum" | "std" | "min" | "max" | "median" => {
                arity(1)?;
                let t = self.check(&args[0], local_cols)?;
                match t {
                    Ty::Column(S::Num) => Ok(Ty::Scalar(S::Num)),
                    other => Err(ExprError::new(format!(
                        "`{name}` aggregates a numeric column, got {}",
                        other.describe()
                    ))),
                }
            }
            "count" => {
                arity(1)?;
                let t = self.check(&args[0], local_cols)?;
                match t {
                    Ty::Column(_) | Ty::Dataset(_) => Ok(Ty::Scalar(S::Num)),
                    other => Err(ExprError::new(format!(
                        "`count` needs a column or dataset, got {}",
                        other.describe()
                    ))),
                }
            }
            "sqrt" | "abs" | "floor" | "ceil" => {
                arity(1)?;
                let t = self.check(&args[0], local_cols)?;
                self.require_numlike(&t)?;
                Ok(t)
            }
            "round" => {
                if args.len() != 1 && args.len() != 2 {
                    return Err(ExprError::new("`round` takes 1 or 2 arguments"));
                }
                let t = self.check(&args[0], local_cols)?;
                self.require_numlike(&t)?;
                if args.len() == 2 {
                    let d = self.check(&args[1], local_cols)?;
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
                let x = self.check(&args[0], local_cols)?;
                let lo = self.check(&args[1], local_cols)?;
                let hi = self.check(&args[2], local_cols)?;
                self.require_numlike(&x)?;
                self.require_numlike(&lo)?;
                self.require_numlike(&hi)?;
                Ok(x)
            }
            "if" => {
                arity(3)?;
                let c = self.check(&args[0], local_cols)?;
                self.require_bool(&c)?;
                let t = self.check(&args[1], local_cols)?;
                let f = self.check(&args[2], local_cols)?;
                let (se, sf) = (self.require_elem(&t)?, self.require_elem(&f)?);
                if se != sf {
                    return Err(ExprError::new(format!(
                        "`if` branches disagree: {} vs {}",
                        t.describe(),
                        f.describe()
                    )));
                }
                let vectorized = c.is_column() || t.is_column() || f.is_column();
                Ok(if vectorized {
                    Ty::Column(se)
                } else {
                    Ty::Scalar(se)
                })
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
}
