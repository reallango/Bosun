/** Logo + title block shown above the login / setup forms. */
export function AuthBrand({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6 flex flex-col items-center text-center sm:mb-8">
      <span className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground shadow-sm">
        B
      </span>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Bosun</h1>
      <p className="mt-1 text-sm text-muted-foreground sm:text-base">{subtitle}</p>
    </div>
  );
}
