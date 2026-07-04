import { forwardRef, type SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  readonly size?: string | number;
};

export const DropboxIcon = forwardRef<SVGSVGElement, IconProps>(function DropboxIcon(
  { size = 24, width = size, height = size, viewBox = "0 0 72 72", fill = "none", ...props },
  ref,
) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={viewBox}
      fill={fill}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      <path
        d="M20.3625 29.575L35.7275 19.7875L20.3625 10L5 19.7875L20.3625 29.575Z"
        fill="#0061FF"
      />
      <path
        d="M51.09 29.575L66.4525 19.7875L51.09 10L35.7275 19.7875L51.09 29.575Z"
        fill="#0061FF"
      />
      <path
        d="M35.7275 39.3627L20.3625 29.5752L5 39.3627L20.3625 49.1502L35.7275 39.3627Z"
        fill="#0061FF"
      />
      <path
        d="M51.09 49.1502L66.4525 39.3627L51.09 29.5752L35.7275 39.3627L51.09 49.1502Z"
        fill="#0061FF"
      />
      <path
        d="M51.09 52.4125L35.7275 42.625L20.3625 52.4125L35.7275 62.2L51.09 52.4125Z"
        fill="#0061FF"
      />
    </svg>
  );
});
