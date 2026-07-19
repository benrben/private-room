import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- shell icons: activity rail, pane chrome, status bar ---------- */

export function HomeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </Stroke>
  );
}

export function PanelLeftIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </Stroke>
  );
}

export function PanelCenterIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M8.5 4.5v15M15.5 4.5v15" />
    </Stroke>
  );
}

export function PanelRightIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </Stroke>
  );
}

export function FocusIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M14 4h6v6" />
      <path d="M10 20H4v-6" />
      <path d="M20 4l-6.5 6.5" />
      <path d="M4 20l6.5-6.5" />
    </Stroke>
  );
}

export function CollapseLeftIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M13 6l-6 6 6 6" />
      <path d="M19 6l-6 6 6 6" />
    </Stroke>
  );
}

export function CollapseRightIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M11 6l6 6-6 6" />
      <path d="M5 6l6 6-6 6" />
    </Stroke>
  );
}

export function LayoutResetIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15M15 4.5v15" />
      <path d="M3.5 9.5h17" opacity="0" />
    </Stroke>
  );
}

export function ThemeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 7a5 5 0 0 1 0 10z" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

export function SettingsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.42-1.4L13.7 2.7h-3.4l-.39 2.44a7 7 0 0 0-2.42 1.4l-2.35-.95-2 3.46 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.42 1.4l.39 2.44h3.4l.39-2.44a7 7 0 0 0 2.42-1.4l2.35.95 2-3.46-2-1.55c.09-.46.14-.92.14-1.4z" />
    </Stroke>
  );
}

export function ShieldIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" />
      <path d="M9 11.5l2 2 4-4.5" />
    </Stroke>
  );
}

export function ActivityIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 6.5h2.5" />
      <path d="M4 12h2.5" />
      <path d="M4 17.5h2.5" />
      <path d="M10 6.5h10" />
      <path d="M10 12h10" />
      <path d="M10 17.5h10" />
    </Stroke>
  );
}

export function ChatBubbleIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z" />
      <path d="M8 9h8M8 12.5h5" />
    </Stroke>
  );
}

export function KeyIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="M11.7 11.7L20 20" />
      <path d="M16.5 16.5l2.3-2.3" />
    </Stroke>
  );
}

export function DatabaseIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </Stroke>
  );
}

export function CloudOffIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M7 17.5h10a4 4 0 0 0 1.2-7.8A5.5 5.5 0 0 0 8 7.8a4.5 4.5 0 0 0-1 8.9z" />
      <path d="M4.5 4.5l15 15" />
    </Stroke>
  );
}
