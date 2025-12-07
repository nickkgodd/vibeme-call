type IconName =
  | 'mic'
  | 'mic-off'
  | 'phone'
  | 'volume'
  | 'volume-off'
  | 'copy'
  | 'x';

const paths: Record<IconName, string> = {
  mic: 'M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4Zm-1 19.93V23h2v-2.07A8.001 8.001 0 0 0 20 13h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93Z',
  'mic-off':
    'M3 3 21 21l-1.5 1.5-3.56-3.56A6 6 0 0 1 12 17a6 6 0 0 1-6-6V9H4v2a8 8 0 0 0 7 7.93V23h2v-4.07a7.96 7.96 0 0 0 2.18-.69L14 16.06V11l-2-2v2.06l-4-4V5a4 4 0 0 1 6.35-3.2l-1.5 1.5A2 2 0 0 0 10 5v.06L5.5.56 3 3Z',
  phone:
    'M6.62 10.79a15.053 15.053 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.05-.24 11.36 11.36 0 0 0 3.56.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.29 21 3 13.71 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.56 1 1 0 0 1-.25 1.05l-2.2 2.2Z',
  volume:
    'M3 9v6h4l5 5V4L7 9H3Zm13.5 3a3.5 3.5 0 0 0-2.07-3.18l-.93-.43v7.22l.93-.43A3.5 3.5 0 0 0 16.5 12Zm2.5 0a6 6 0 0 0-3.55-5.47l-1.05-.46v2.18l.48.25A4 4 0 0 1 18 12a4 4 0 0 1-3.12 3.9l-.48.25v2.18l1.05-.46A6 6 0 0 0 19 12Z',
  'volume-off':
    'm3 9 2-2 4 4 4-4 2 2-4 4 4 4-2 2-4-4-4 4-2-2 4-4-4-4Zm12.84-6.9 1.66-1.12A12 12 0 0 1 23 12a12 12 0 0 1-5.5 10.03l-1.66-1.12A10 10 0 0 0 21 12a10 10 0 0 0-5.16-8.9Z',
  copy:
    'M8 3a2 2 0 0 1 2-2h7l4 4v11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V3Zm2 0v13h9V7h-4V3h-5Zm-6 4h2v12h11v2H4a2 2 0 0 1-2-2V7Z',
  x: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.6 13.4l-6.3 6.3-1.41-1.42L9.18 12 2.89 5.71 4.3 4.29l6.3 6.3 6.29-6.3 1.42 1.42Z'
};

type IconProps = {
  name: IconName;
  className?: string;
  size?: number;
};

export default function Icon({ name, className, size = 22 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={className}
      fill="currentColor"
    >
      <path d={paths[name]} />
    </svg>
  );
}


