// Inline icons. All inherit currentColor and are hidden from the accessibility
// tree; the control that holds an icon carries the real label.
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

export const PlusIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
);
export const SearchIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
);
export const SendIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const StopIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>
);
export const CopyIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
);
export const CheckIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="m5 12 4.5 4.5L19 7" /></svg>
);
export const RegenerateIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M20 11a8 8 0 1 0-2.3 5.6" /><path d="M20 4v5h-5" /></svg>
);
export const EditIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17v3z" /><path d="M14 7l3 3" /></svg>
);
export const TrashIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
);
export const MenuIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const CloseIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const ChevronDownIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="m6 9 6 6 6-6" /></svg>
);
export const ArrowDownIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
);
export const SignOutIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" /><path d="M10 12H3m0 0 3.5-3.5M3 12l3.5 3.5" /></svg>
);
export const SunIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>
);
export const MoonIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" /></svg>
);
export const SparkIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M12 3c.4 3.6 1.8 5 5.4 5.4-3.6.4-5 1.8-5.4 5.4-.4-3.6-1.8-5-5.4-5.4C9.8 8 11.2 6.6 12 3z" /><path d="M18 14c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5C17.1 16.3 17.8 15.6 18 14z" /></svg>
);
