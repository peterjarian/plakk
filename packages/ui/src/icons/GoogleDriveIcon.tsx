import { forwardRef, type SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  readonly size?: string | number;
};

export const GoogleDriveIcon = forwardRef<SVGSVGElement, IconProps>(function GoogleDriveIcon(
  { size = 24, width = size, height = size, viewBox = "0 0 72 73", fill = "none", ...props },
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
        d="M13.9464 53.5412L16.2485 57.5175C16.7268 58.3546 17.4144 59.0123 18.2216 59.4907L26.4433 45.2598H10C10 46.1866 10.2392 47.1134 10.7175 47.9505L13.9464 53.5412Z"
        fill="#0066DA"
      />
      <path
        d="M36.1 28.5171L27.8783 14.2861C27.0711 14.7645 26.3835 15.4222 25.9052 16.2593L10.7175 42.5686C10.248 43.3877 10.0006 44.3152 10 45.2593H26.4433L36.1 28.5171Z"
        fill="#00AC47"
      />
      <path
        d="M53.9784 59.4907C54.7856 59.0123 55.4732 58.3546 55.9515 57.5175L56.9082 55.8732L61.4825 47.9505C61.9608 47.1134 62.2 46.1866 62.2 45.2598H45.7555L49.2546 52.1361L53.9784 59.4907Z"
        fill="#EA4335"
      />
      <path
        d="M36.1 28.5173L44.3217 14.2864C43.5144 13.808 42.5876 13.5688 41.6309 13.5688H30.5691C29.6124 13.5688 28.6856 13.8379 27.8784 14.2864L36.1 28.5173Z"
        fill="#00832D"
      />
      <path
        d="M45.7567 45.2598H26.4433L18.2216 59.4907C19.0289 59.969 19.9557 60.2082 20.9124 60.2082H51.2876C52.2443 60.2082 53.1711 59.9391 53.9784 59.4907L45.7567 45.2598Z"
        fill="#2684FC"
      />
      <path
        d="M53.8887 29.414L46.2949 16.2593C45.8165 15.4222 45.1289 14.7645 44.3217 14.2861L36.1 28.5171L45.7567 45.2593H62.1701C62.1701 44.3325 61.9309 43.4057 61.4526 42.5686L53.8887 29.414Z"
        fill="#FFBA00"
      />
    </svg>
  );
});
