import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  // Cards that are themselves a control (clickable widgets, list tiles)
  // lift slightly on hover and give under a press. Static cards stay put —
  // a surface that reacts to the pointer without doing anything is noise.
  interactive?: boolean;
}) {
  const motionClasses = interactive
    ? "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-floating active:translate-y-0 active:scale-[0.995] active:duration-75 cursor-pointer"
    : "";
  return <div className={`glass rounded-card ${motionClasses} ${className}`} {...props} />;
}
