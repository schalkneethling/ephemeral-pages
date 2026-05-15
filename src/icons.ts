import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  Flag,
  FileUp,
  Hourglass,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Rocket,
  Sparkles,
  Trash2,
  type IconNode,
} from "lucide";

const ICONS = {
  ban: Ban,
  check: Check,
  checkCircle: CheckCircle2,
  chevronDown: ChevronDown,
  circleAlert: CircleAlert,
  clipboard: Clipboard,
  clock: Clock3,
  copy: Copy,
  externalLink: ExternalLink,
  fileCode: FileCode2,
  flag: Flag,
  fileUp: FileUp,
  hourglass: Hourglass,
  link: Link2,
  loader: LoaderCircle,
  lock: LockKeyhole,
  rocket: Rocket,
  sparkles: Sparkles,
  trash: Trash2,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = "icon") {
  return unsafeSVG(htmlIcon(name, className));
}

export function htmlIcon(name: IconName, className = "icon"): string {
  const nodes = ICONS[name].map(renderIconNode).join("");

  return `<svg class="${className}" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>`;
}

export function svgDataIcon(name: IconName, color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    htmlIcon(name, "icon").replace('class="icon"', "").replaceAll("currentColor", color),
  )}`;
}

function renderIconNode([tag, attrs]: IconNode[number]): string {
  const attrText = Object.entries(attrs)
    .map(([name, value]) => `${name}="${String(value)}"`)
    .join(" ");

  return `<${tag} ${attrText}></${tag}>`;
}
