interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  /** Page-level controls shown to the right of the title on wide screens. */
  actions?: React.ReactNode;
}

/** Title block shared by every settings page (an h2: the shell header holds the page's h1, "Settings"). */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}
