// A small key glyph for the recovery affordance and sheet (24px grid, 1.6px
// stroke, currentColor so it inherits accent/slate). This is the room's
// recovery-key icon.
export function RecoveryKeyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3" />
      <path d="M16.5 6.5 19 9" />
      <path d="M14 9l2 2" />
    </svg>
  );
}
