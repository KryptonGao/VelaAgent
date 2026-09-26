interface IconProps {
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export function FolderIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function MonitorIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function BranchIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function ShieldIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function GithubIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

export function SearchIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

export function GridIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="5.5" cy="5.5" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <circle cx="18.5" cy="5.5" r="1.6" />
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  );
}

export function MoreIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function CloseIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 11 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 11 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export function SendIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M22 2L11 13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function CheckIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function ImageIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

export function TerminalIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <polyline points="7 9 10 12 7 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </svg>
  );
}

export function EyeIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function PencilIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function FilePlusIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

export function FileIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function StackIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 12 12 17 22 12" />
      <polyline points="2 17 12 22 22 17" />
    </svg>
  );
}

export function SkillIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12.8 2.2a2 2 0 0 0-1.6 0L3 6.1a1 1 0 0 0 0 1.8l8.2 3.7a2 2 0 0 0 1.6 0L21 7.9a1 1 0 0 0 0-1.8Z" />
      <path d="M3 12l8.2 3.7a2 2 0 0 0 1.6 0L21 12" />
      <path d="M3 16.5l8.2 3.7a2 2 0 0 0 1.6 0L21 16.5" />
    </svg>
  );
}

export function PrIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <line x1="6" y1="9" x2="6" y2="15" />
      <path d="M18 15a9 9 0 0 0-9-6" />
    </svg>
  );
}

export function QuestionIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <path d="M9.7 9.3a2.4 2.4 0 0 1 4.7.7c0 1.6-2.4 2-2.4 3.2" />
      <line x1="12" y1="16.4" x2="12" y2="16.5" />
    </svg>
  );
}
