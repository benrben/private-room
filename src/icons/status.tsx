import { IconProps } from "./types";
import { Stroke } from "./base";

export function LockIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="5" y="11" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" />
      <circle cx="12" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.7" />
    </Stroke>
  );
}

export function CloudIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1-.5 8.5z" />
    </Stroke>
  );
}

export function MemoryIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6.5 4.5h11a1 1 0 0 1 1 1v14l-6.5-4-6.5 4v-14a1 1 0 0 1 1-1z" />
    </Stroke>
  );
}

export function DotsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.4" fill="currentColor" stroke="none" />
    </Stroke>
  );
}
