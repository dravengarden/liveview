// The widget REGISTRY — every `Widget` variant → one MUI-built control. Two
// coverage mechanisms keep the catalog closed: `WIDGET_REGISTRY` is
// `satisfies Record<WidgetType, …>` (a missing key is a compile error) and
// `renderWidget` ends in an exhaustive `never` default. Add a widget = add a
// variant in `types.ts` + a component + both entries here; nothing else moves.
//
// Mobile-first: every control is full-width, tap targets stay ≥44px (the app
// theme floors coarse-pointer controls; we avoid size="small" on inputs), and
// nothing relies on hover.

import type { JSX } from "react";
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  IconButton,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  type SelectChangeEvent,
  Slider,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { Add as AddIcon, Remove as RemoveIcon } from "@mui/icons-material";
import type { Opt, Widget, WidgetType } from "./types";
import { Kernel, useKernelVersion } from "./kernel";

function assertNever(x: never): never {
  throw new Error(`unhandled widget: ${JSON.stringify(x)}`);
}

// Stable identity for an option's raw JSON value (number/string/boolean), used
// as the DOM select/toggle key while the signal stores the value verbatim.
function keyOf(v: unknown): string {
  return JSON.stringify(v ?? null);
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A labelled, full-width control wrapper. */
function Field({ label, children }: { label?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <Box sx={{ width: "100%" }}>
      {label ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          {label}
        </Typography>
      ) : null}
      {children}
    </Box>
  );
}

interface Ctl<K extends WidgetType> {
  w: Extract<Widget, { type: K }>;
  signal: string;
  kernel: Kernel;
}

function SliderWidget({ w, signal, kernel }: Ctl<"slider">): JSX.Element {
  useKernelVersion(kernel);
  const value = num(kernel.get(signal), w.min);
  return (
    <Field label={w.label}>
      <Slider
        value={value}
        min={w.min}
        max={w.max}
        step={w.step ?? 1}
        valueLabelDisplay="auto"
        onChange={(_e: Event, nv: number | number[]) => kernel.set(signal, Array.isArray(nv) ? nv[0] : nv)}
        sx={{ width: "100%" }}
      />
    </Field>
  );
}

function RangeSliderWidget({ w, signal, kernel }: Ctl<"rangeSlider">): JSX.Element {
  useKernelVersion(kernel);
  const raw = kernel.get(signal);
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  const value: number[] = [num(arr[0], w.min), num(arr[1], w.max)];
  return (
    <Field label={w.label}>
      <Slider
        value={value}
        min={w.min}
        max={w.max}
        step={w.step ?? 1}
        valueLabelDisplay="auto"
        onChange={(_e: Event, nv: number | number[]) => {
          if (Array.isArray(nv)) kernel.set(signal, [nv[0], nv[1]]);
        }}
        sx={{ width: "100%" }}
      />
    </Field>
  );
}

function NumberInputWidget({ w, signal, kernel }: Ctl<"numberInput">): JSX.Element {
  useKernelVersion(kernel);
  const value = num(kernel.get(signal), 0);
  const bounds = {
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
    ...(w.step !== undefined ? { step: w.step } : {}),
  };
  return (
    <Field label={w.label}>
      <TextField
        type="number"
        value={String(value)}
        fullWidth
        onChange={(e) => {
          const n = Number(e.target.value);
          kernel.set(signal, Number.isFinite(n) ? n : 0);
        }}
        slotProps={{ htmlInput: bounds }}
      />
    </Field>
  );
}

function StepperWidget({ w, signal, kernel }: Ctl<"stepper">): JSX.Element {
  useKernelVersion(kernel);
  const value = Math.round(num(kernel.get(signal), 0));
  const clamp = (n: number): number => {
    let out = n;
    if (w.min !== undefined) out = Math.max(w.min, out);
    if (w.max !== undefined) out = Math.min(w.max, out);
    return out;
  };
  return (
    <Field label={w.label}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <IconButton aria-label="decrement" onClick={() => kernel.set(signal, clamp(value - 1))} sx={{ width: 44, height: 44 }}>
          <RemoveIcon />
        </IconButton>
        <Typography variant="body1" sx={{ minWidth: 40, textAlign: "center" }}>
          {value}
        </Typography>
        <IconButton aria-label="increment" onClick={() => kernel.set(signal, clamp(value + 1))} sx={{ width: 44, height: 44 }}>
          <AddIcon />
        </IconButton>
      </Box>
    </Field>
  );
}

function ToggleWidget({ w, signal, kernel }: Ctl<"toggle">): JSX.Element {
  useKernelVersion(kernel);
  const checked = kernel.get(signal) === true;
  return (
    <FormControlLabel
      sx={{ width: "100%", m: 0, justifyContent: "space-between" }}
      labelPlacement="start"
      control={<Switch checked={checked} onChange={(e) => kernel.set(signal, e.target.checked)} />}
      label={w.label ?? ""}
    />
  );
}

function SegmentedWidget({ w, signal, kernel }: Ctl<"segmented">): JSX.Element {
  useKernelVersion(kernel);
  const current = keyOf(kernel.get(signal));
  return (
    <Field label={w.label}>
      <ToggleButtonGroup
        exclusive
        fullWidth
        value={current}
        onChange={(_e, key: string | null) => {
          if (key === null) return;
          const opt = w.options.find((o) => keyOf(o.value) === key);
          if (opt) kernel.set(signal, opt.value);
        }}
      >
        {w.options.map((o) => (
          <ToggleButton key={keyOf(o.value)} value={keyOf(o.value)}>
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Field>
  );
}

function RadioGroupWidget({ w, signal, kernel }: Ctl<"radioGroup">): JSX.Element {
  useKernelVersion(kernel);
  const current = keyOf(kernel.get(signal));
  return (
    <Field label={w.label}>
      <RadioGroup
        value={current}
        onChange={(_e, key) => {
          const opt = w.options.find((o) => keyOf(o.value) === key);
          if (opt) kernel.set(signal, opt.value);
        }}
      >
        {w.options.map((o) => (
          <FormControlLabel key={keyOf(o.value)} value={keyOf(o.value)} control={<Radio />} label={o.label} />
        ))}
      </RadioGroup>
    </Field>
  );
}

function SelectWidget({ w, signal, kernel }: Ctl<"select">): JSX.Element {
  useKernelVersion(kernel);
  const current = keyOf(kernel.get(signal));
  return (
    <Field label={w.label}>
      <Select
        fullWidth
        value={current}
        onChange={(e: SelectChangeEvent<string>) => {
          const opt = w.options.find((o) => keyOf(o.value) === e.target.value);
          if (opt) kernel.set(signal, opt.value);
        }}
      >
        {w.options.map((o) => (
          <MenuItem key={keyOf(o.value)} value={keyOf(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Select>
    </Field>
  );
}

function labelsFor(options: Opt[], keys: string[]): string {
  return keys
    .map((k) => options.find((o) => keyOf(o.value) === k)?.label ?? "")
    .filter((s) => s !== "")
    .join(", ");
}

function valuesFor(options: Opt[], keys: string[]): unknown[] {
  return keys.map((k) => options.find((o) => keyOf(o.value) === k)).filter((o): o is Opt => o !== undefined).map((o) => o.value);
}

function MultiSelectWidget({ w, signal, kernel }: Ctl<"multiSelect">): JSX.Element {
  useKernelVersion(kernel);
  const raw = kernel.get(signal);
  const selected = (Array.isArray(raw) ? raw : []).map((v) => keyOf(v));
  return (
    <Field label={w.label}>
      <Select<string[]>
        multiple
        fullWidth
        value={selected}
        renderValue={(sel) => labelsFor(w.options, sel)}
        onChange={(e: SelectChangeEvent<string[]>) => {
          const raw2 = e.target.value;
          const keys = typeof raw2 === "string" ? raw2.split(",") : raw2;
          kernel.set(signal, valuesFor(w.options, keys));
        }}
      >
        {w.options.map((o) => (
          <MenuItem key={keyOf(o.value)} value={keyOf(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Select>
    </Field>
  );
}

function CheckboxGroupWidget({ w, signal, kernel }: Ctl<"checkboxGroup">): JSX.Element {
  useKernelVersion(kernel);
  const raw = kernel.get(signal);
  const selected = new Set((Array.isArray(raw) ? raw : []).map((v) => keyOf(v)));
  const toggle = (o: Opt, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(keyOf(o.value));
    else next.delete(keyOf(o.value));
    kernel.set(signal, valuesFor(w.options, [...next]));
  };
  return (
    <Field label={w.label}>
      <FormGroup>
        {w.options.map((o) => (
          <FormControlLabel
            key={keyOf(o.value)}
            control={<Checkbox checked={selected.has(keyOf(o.value))} onChange={(e) => toggle(o, e.target.checked)} />}
            label={o.label}
          />
        ))}
      </FormGroup>
    </Field>
  );
}

function TextInputWidget({ w, signal, kernel }: Ctl<"textInput">): JSX.Element {
  useKernelVersion(kernel);
  const value = String(kernel.get(signal) ?? "");
  const htmlInput = { ...(w.maxLength !== undefined ? { maxLength: w.maxLength } : {}) };
  return (
    <Field label={w.label}>
      <TextField fullWidth value={value} onChange={(e) => kernel.set(signal, e.target.value)} slotProps={{ htmlInput }} />
    </Field>
  );
}

function DatePickerWidget({ w, signal, kernel }: Ctl<"datePicker">): JSX.Element {
  useKernelVersion(kernel);
  const value = String(kernel.get(signal) ?? "");
  const htmlInput = {
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
  };
  return (
    <Field label={w.label}>
      <TextField type="date" fullWidth value={value} onChange={(e) => kernel.set(signal, e.target.value)} slotProps={{ htmlInput }} />
    </Field>
  );
}

function DateRangeWidget({ w, signal, kernel }: Ctl<"dateRange">): JSX.Element {
  useKernelVersion(kernel);
  const raw = kernel.get(signal);
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  const lo = String(arr[0] ?? "");
  const hi = String(arr[1] ?? "");
  const htmlInput = {
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
  };
  return (
    <Field label={w.label}>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <TextField
          type="date"
          value={lo}
          onChange={(e) => kernel.set(signal, [e.target.value, hi])}
          slotProps={{ htmlInput }}
          sx={{ flex: 1, minWidth: 130 }}
        />
        <TextField
          type="date"
          value={hi}
          onChange={(e) => kernel.set(signal, [lo, e.target.value])}
          slotProps={{ htmlInput }}
          sx={{ flex: 1, minWidth: 130 }}
        />
      </Box>
    </Field>
  );
}

function ButtonWidget({ w, kernel }: { w: Extract<Widget, { type: "button" }>; kernel: Kernel }): JSX.Element {
  const reset = w.action?.reset ?? [];
  return (
    <Button variant="outlined" fullWidth onClick={() => kernel.reset(reset)} sx={{ minHeight: 44 }}>
      {w.label ?? "Button"}
    </Button>
  );
}

/** The registry map — `satisfies Record<WidgetType, …>` forces an entry for
 *  every widget type (a missing one is a compile error). */
export const WIDGET_REGISTRY = {
  slider: SliderWidget,
  rangeSlider: RangeSliderWidget,
  numberInput: NumberInputWidget,
  stepper: StepperWidget,
  toggle: ToggleWidget,
  segmented: SegmentedWidget,
  radioGroup: RadioGroupWidget,
  select: SelectWidget,
  multiSelect: MultiSelectWidget,
  checkboxGroup: CheckboxGroupWidget,
  textInput: TextInputWidget,
  datePicker: DatePickerWidget,
  dateRange: DateRangeWidget,
  button: ButtonWidget,
} satisfies Record<WidgetType, unknown>;

/** Dispatch a widget to its component. The exhaustive `switch` (with a `never`
 *  default) makes a new, unhandled variant a TypeScript compile error. */
export function renderWidget(widget: Widget, signal: string | null, kernel: Kernel): JSX.Element {
  const sig = signal ?? "";
  switch (widget.type) {
    case "slider":
      return <SliderWidget w={widget} signal={sig} kernel={kernel} />;
    case "rangeSlider":
      return <RangeSliderWidget w={widget} signal={sig} kernel={kernel} />;
    case "numberInput":
      return <NumberInputWidget w={widget} signal={sig} kernel={kernel} />;
    case "stepper":
      return <StepperWidget w={widget} signal={sig} kernel={kernel} />;
    case "toggle":
      return <ToggleWidget w={widget} signal={sig} kernel={kernel} />;
    case "segmented":
      return <SegmentedWidget w={widget} signal={sig} kernel={kernel} />;
    case "radioGroup":
      return <RadioGroupWidget w={widget} signal={sig} kernel={kernel} />;
    case "select":
      return <SelectWidget w={widget} signal={sig} kernel={kernel} />;
    case "multiSelect":
      return <MultiSelectWidget w={widget} signal={sig} kernel={kernel} />;
    case "checkboxGroup":
      return <CheckboxGroupWidget w={widget} signal={sig} kernel={kernel} />;
    case "textInput":
      return <TextInputWidget w={widget} signal={sig} kernel={kernel} />;
    case "datePicker":
      return <DatePickerWidget w={widget} signal={sig} kernel={kernel} />;
    case "dateRange":
      return <DateRangeWidget w={widget} signal={sig} kernel={kernel} />;
    case "button":
      return <ButtonWidget w={widget} kernel={kernel} />;
    default:
      return assertNever(widget);
  }
}
