/* ---------- empty-state illustrations ---------- */

/** Empty viewer: an open door with violet light spilling out. */
export function EmptyViewerArt() {
  return (
    <svg width="210" height="164" viewBox="0 0 220 172" fill="none" aria-hidden>
      <defs>
        <radialGradient id="pv-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pv-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="pv-wedge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </linearGradient>
      </defs>

      <ellipse cx="110" cy="84" rx="100" ry="70" fill="url(#pv-glow)" />

      {/* light spilling onto the floor */}
      <path d="M82 150h56l26 18H54l28-18z" fill="url(#pv-wedge)" />

      {/* doorway interior */}
      <path
        d="M82 150V80a28 28 0 0 1 56 0v70H82z"
        fill="url(#pv-light)"
        opacity="0.85"
      />

      {/* arch frame */}
      <path
        d="M78 150V80a32 32 0 0 1 64 0v70"
        stroke="#8b93a7"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M64 150h92"
        stroke="#8b93a7"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* door panel, swung open */}
      <path
        d="M82 150l-30 12V70l30 8v72z"
        fill="#1c212c"
        stroke="#262d3b"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="58" cy="116" r="2.4" fill="#8b93a7" />

      {/* sparkles */}
      <path
        d="M164 52c.4 2.7 1.7 4.1 4.4 4.5-2.7.4-4 1.8-4.4 4.5-.4-2.7-1.7-4.1-4.4-4.5 2.7-.4 4-1.8 4.4-4.5z"
        fill="#8b7cf6"
      />
      <circle cx="152" cy="76" r="1.6" fill="#8b7cf6" opacity="0.7" />
      <circle cx="46" cy="46" r="1.4" fill="#8b7cf6" opacity="0.45" />

      {/* plant */}
      <path
        d="M182 150v-12m0 4c0-5 3-8 7-9m-7 4c0-4-2.5-6.5-6-7"
        stroke="#8b93a7"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Empty chat: a keyhole with a chat bubble — ask the room anything. */
export function EmptyChatArt() {
  return (
    <svg width="170" height="140" viewBox="0 0 200 164" fill="none" aria-hidden>
      <defs>
        <radialGradient id="pc-glow" cx="45%" cy="55%" r="55%">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="90" cy="90" rx="90" ry="66" fill="url(#pc-glow)" />

      {/* dashed orbit */}
      <path
        d="M28 118a62 62 0 0 1 46-74"
        stroke="#262d3b"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1 9"
      />

      {/* keyhole */}
      <circle
        cx="86"
        cy="78"
        r="20"
        fill="rgba(139,124,246,0.16)"
        stroke="#8b7cf6"
        strokeWidth="3"
      />
      <path
        d="M86 94l-10 34h20l-10-34z"
        fill="rgba(139,124,246,0.16)"
        stroke="#8b7cf6"
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* chat bubble */}
      <path
        d="M124 26h44a10 10 0 0 1 10 10v18a10 10 0 0 1-10 10h-24l-12 12v-12h-8a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z"
        fill="#1c212c"
        stroke="#8b93a7"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="136" cy="45" r="2.6" fill="#8b7cf6" />
      <circle cx="146" cy="45" r="2.6" fill="#8b7cf6" />
      <circle cx="156" cy="45" r="2.6" fill="#8b7cf6" />

      {/* sparkles */}
      <path
        d="M152 96c.4 2.7 1.7 4.1 4.4 4.5-2.7.4-4 1.8-4.4 4.5-.4-2.7-1.7-4.1-4.4-4.5 2.7-.4 4-1.8 4.4-4.5z"
        fill="#8b7cf6"
      />
      <circle cx="38" cy="42" r="1.6" fill="#8b7cf6" opacity="0.6" />
    </svg>
  );
}
