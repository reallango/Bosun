'use client';

/** The steps a provisioning run reports: successes with a tick, "Warning: ..." steps in amber. */
export function ProvisionSteps({ steps, title = 'Provisioning Successful!' }: { steps: string[]; title?: string }) {
  return (
    <div className="rounded-md border border-green-500/30 bg-green-500/10 p-4">
      <div className="mb-2 font-medium text-success">{title}</div>
      <div className="space-y-1 text-sm">
        {steps.map((step, i) => {
          const warning = step.startsWith('Warning: ');
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={warning ? 'text-warning' : 'text-success'} aria-hidden>{warning ? '⚠' : '✓'}</span>
              <span className={`min-w-0 break-words ${warning ? 'text-warning' : 'text-success'}`}>
                {warning ? <><span className="sr-only">Warning: </span>{step.slice('Warning: '.length)}</> : step}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
