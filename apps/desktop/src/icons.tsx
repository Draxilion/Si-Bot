// Stroke icons, 24px grid, drawn with currentColor.
const svg = (children: React.ReactNode) => <svg viewBox="0 0 24 24">{children}</svg>

export const Icon = {
  chat: svg(<path d="M4 5h16v11H8l-4 4z" />),
  tasks: svg(
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M9 2h6" />
    </>,
  ),
  memory: svg(
    <>
      <path d="M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5A3.5 3.5 0 0 0 9 20h.5M12 4a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5A3.5 3.5 0 0 1 15 20h-.5M12 4v16" />
    </>,
  ),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </>,
  ),
  send: svg(<path d="M12 19V5M5 12l7-7 7 7" />),
  stop: svg(<rect x="7" y="7" width="10" height="10" rx="2" className="fill" />),
  think: svg(
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" />,
  ),
  deep: svg(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5" />
    </>,
  ),
  web_search: svg(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>,
  ),
  read_page: svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M9 12h6M9 16h6" />
    </>,
  ),
  run_code: svg(<path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />),
  remember: svg(<path d="M6 4h12v17l-6-4-6 4z" />),
  recall_memory: svg(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>,
  ),
  create_task: svg(
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5" />
    </>,
  ),
  tool: svg(<path d="M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3z" />),
  trash: svg(<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />),
  copy: svg(
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>,
  ),
  check: svg(<path d="M5 12l5 5 9-10" />),
  retry: svg(
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5" />
      <path d="M20 3v5.5h-5.5" />
    </>,
  ),
  edit: svg(<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />),
  speak: svg(
    <>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    </>,
  ),
  mic: svg(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
  ),
  attach: svg(<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7" />),
  file: svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>,
  ),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />),
  chevron: svg(<path d="M9 6l6 6-6 6" />),
  play: svg(<path d="M7 5l12 7-12 7z" />),
  pause: svg(<path d="M8 5v14M16 5v14" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  down: svg(<path d="M12 5v14M5 12l7 7 7-7" />),
  spark: svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />),
}

export type IconName = keyof typeof Icon
