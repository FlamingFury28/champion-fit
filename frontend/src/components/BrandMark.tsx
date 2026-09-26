interface BrandMarkProps {
  className?: string
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <img
      className={className}
      src="/champion-fit-symbol.png"
      width={48}
      height={48}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  )
}
