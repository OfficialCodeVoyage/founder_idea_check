const PROVIDERS = ["OpenAI", "Anthropic", "Google", "xAI", "Meta"];

export function LogoCloud() {
  return (
    <section className="border-border/30 border-y py-12">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-foreground/75 text-sm uppercase tracking-wide">
          Access 120+ models from leading AI providers
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-14 gap-y-4">
          {PROVIDERS.map((name) => (
            <span
              className="font-medium text-foreground/75 text-xl tracking-tight transition-colors hover:text-foreground"
              key={name}
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
