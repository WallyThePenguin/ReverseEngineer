Form controls follow macOS: a 28px field with a 1px `border-strong` outline that becomes a 3px `focus` halo on focus; search fields are borderless on `surface-3`; checkboxes and radios fill `accent` when on; switches are 42x26 pills with a white knob; segmented controls sit on `surface-3` with a raised `surface-1` thumb.

The consumer provides labels, values and ids; use `role="checkbox"|"radio"|"switch"` with `aria-checked`, or `aria-pressed` for segments. Placeholders use `ink-subtle`. Show errors as `danger` text with an x icon under the field.
