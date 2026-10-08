import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@fundroomhq/ui";
import { ExternalLink, FileText, Play, Scale } from "lucide-react";
import { Markdown } from "../../lib/markdown.js";
import type {
  ContentSettingsLike,
  RenderedBlock,
  RenderedPage,
  RenderedSection,
  VisibilityRule,
} from "../../lib/queries.js";
import { MetricGridBlock } from "../../modules/metrics/metric-grid-block.js";
import { RoundSummaryBlock } from "../../modules/round/round-summary-block.js";
import { m } from "../../paraglide/messages.js";

/*
 * Renders a page the server has already filtered and hydrated. Block data is typed loosely
 * (the registry lives on the server); every renderer validates the shape it needs and shows
 * nothing for a block it cannot read, so a newer server never breaks an older client.
 */
export function visibilityLabel(
  rule: VisibilityRule,
  groups?: readonly { id: string; name: string }[],
): string {
  switch (rule.mode) {
    case "public":
      return m.content_vis_public();
    case "staff_only":
      return m.content_vis_staff_only();
    case "groups": {
      const names = rule.groupIds.map((id) => groups?.find((g) => g.id === id)?.name ?? "…");
      return m.content_vis_groups({ groups: names.join(", ") });
    }
    default:
      return m.content_vis_authenticated();
  }
}

export function PageRenderer({
  page,
  showAudience = false,
  groups,
}: {
  page: RenderedPage;
  /** Staff view: badge each section with its audience. */
  showAudience?: boolean;
  groups?: readonly { id: string; name: string }[];
}) {
  if (page.sections.length === 0) {
    return <p className="text-sm text-muted-foreground">{m.content_empty_page()}</p>;
  }
  return (
    <div className="space-y-10">
      {page.sections.map((section) => (
        <SectionView
          key={section.key}
          section={section}
          showAudience={showAudience}
          groups={groups}
        />
      ))}
    </div>
  );
}

function SectionView({
  section,
  showAudience,
  groups,
}: {
  section: RenderedSection;
  showAudience: boolean;
  groups?: readonly { id: string; name: string }[] | undefined;
}) {
  const headingId = `section-${section.key}`;
  return (
    <section aria-labelledby={section.title ? headingId : undefined} data-section={section.key}>
      {section.title || showAudience ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {section.title ? (
            <h2 id={headingId} className="text-xl font-semibold tracking-tight">
              {section.title}
            </h2>
          ) : null}
          {showAudience ? (
            <Badge variant={section.visibility.mode === "public" ? "destructive" : "outline"}>
              {visibilityLabel(section.visibility, groups)}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-6">
        {section.blocks.map((block) => (
          <BlockView key={block.id} block={block} />
        ))}
      </div>
    </section>
  );
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function BlockView({ block }: { block: RenderedBlock }) {
  const d = block.data;
  switch (block.type) {
    case "hero": {
      const heading = str(d["heading"]);
      if (heading === null) return null;
      const sub = str(d["subheading"]);
      const image = str(d["imageUrl"]);
      const cta = d["cta"] as { label?: unknown; href?: unknown } | null;
      const ctaLabel = cta ? str(cta.label) : null;
      const ctaHref = cta ? str(cta.href) : null;
      return (
        <div className="rounded-xl border bg-card p-8 text-card-foreground">
          <div className="flex flex-col gap-6 md:flex-row md:items-center">
            <div className="flex-1 space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight">{heading}</h1>
              {sub ? <p className="max-w-prose text-lg text-muted-foreground">{sub}</p> : null}
              {ctaLabel && ctaHref ? (
                <Button asChild>
                  <a
                    href={ctaHref}
                    {...(ctaHref.startsWith("/")
                      ? {}
                      : { rel: "noopener noreferrer", target: "_blank" })}
                  >
                    {ctaLabel}
                  </a>
                </Button>
              ) : null}
            </div>
            {image ? (
              <img src={image} alt="" className="max-h-64 rounded-lg object-cover md:w-1/3" />
            ) : null}
          </div>
        </div>
      );
    }
    case "rich_text": {
      const text = str(d["text"]);
      return text ? (
        <Markdown source={text} className="prose prose-neutral max-w-prose dark:prose-invert" />
      ) : null;
    }
    case "team": {
      const members = Array.isArray(d["members"])
        ? (d["members"] as Record<string, unknown>[])
        : [];
      if (members.length === 0) return null;
      return (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((mem, i) => {
            const name = str(mem["name"]);
            if (name === null) return null;
            const photo = str(mem["photoUrl"]);
            const linkedin = str(mem["linkedinUrl"]);
            return (
              <li key={`${block.id}-${i}`}>
                <Card className="h-full">
                  <CardHeader>
                    {photo ? (
                      <img src={photo} alt="" className="size-16 rounded-full object-cover" />
                    ) : null}
                    <CardTitle>{name}</CardTitle>
                    {str(mem["title"]) ? (
                      <p className="text-sm text-muted-foreground">{str(mem["title"])}</p>
                    ) : null}
                  </CardHeader>
                  {str(mem["bio"]) || linkedin ? (
                    <CardContent className="space-y-2 text-sm">
                      {str(mem["bio"]) ? <p>{str(mem["bio"])}</p> : null}
                      {linkedin ? (
                        <a
                          href={linkedin}
                          rel="noopener noreferrer"
                          target="_blank"
                          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                        >
                          LinkedIn <ExternalLink aria-hidden="true" className="size-3" />
                        </a>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      );
    }
    case "faq": {
      const items = Array.isArray(d["items"]) ? (d["items"] as Record<string, unknown>[]) : [];
      if (items.length === 0) return null;
      return (
        <dl className="divide-y rounded-lg border">
          {items.map((item, i) => (
            <div key={`${block.id}-${i}`} className="space-y-1 p-4">
              <dt className="font-medium">{str(item["question"])}</dt>
              <dd className="text-sm text-muted-foreground">{str(item["answer"])}</dd>
            </div>
          ))}
        </dl>
      );
    }
    case "embed": {
      const url = str(d["url"]);
      if (url === null) return null;
      const title = str(d["title"]) ?? url;
      const provider = str(d["provider"]) ?? "other";
      return (
        <a
          href={url}
          rel="noopener noreferrer"
          target="_blank"
          className="flex items-center gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/40"
        >
          <Play aria-hidden="true" className="size-5 text-primary" />
          <span className="flex-1">
            <span className="block font-medium">{title}</span>
            <span className="block text-xs text-muted-foreground">
              {m.content_embed_open({ provider })}
            </span>
          </span>
          <ExternalLink aria-hidden="true" className="size-4 text-muted-foreground" />
        </a>
      );
    }
    case "disclaimer": {
      /*
       * The text is the server's, hydrated from the workspace's legal library (E1.6): the
       * block itself only ever held a slug. A workspace that has not written a disclaimer
       * hydrates to nothing, and nothing is what we show — an empty legal notice would be
       * worse than none at all.
       */
      const h = d["hydrated"] as Record<string, unknown> | null | undefined;
      const body = h ? str(h["body"]) : null;
      if (body === null) return null;
      const versionNo = h && typeof h["versionNo"] === "number" ? h["versionNo"] : null;
      const title = (h ? str(h["title"]) : null) ?? m.content_block_disclaimer();
      return (
        <aside
          aria-label={title}
          className="rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Scale aria-hidden="true" className="size-3.5" />
            {versionNo === null
              ? title
              : m.content_disclaimer_version({ title, version: versionNo })}
          </p>
          <Markdown
            source={body}
            className="prose prose-sm prose-neutral max-w-prose dark:prose-invert"
          />
        </aside>
      );
    }
    case "metric_grid": {
      /*
       * E2.4 §10. The block stores ids; `modules/metrics`' hydrator answers with the tiles
       * this reader may see and drops the rest without saying so. `MetricGridBlock` renders
       * nothing at all for an empty payload — never a "hidden metric" placeholder, which
       * would leak the existence of a number the workspace chose not to show this reader.
       */
      if (block.unavailable !== undefined) return <ReferenceBlock block={block} />;
      return <MetricGridBlock hydrated={block.data["hydrated"]} />;
    }
    case "round_summary": {
      /*
       * E2.5 §R. A reference block: the page stores `{}` and `modules/round`'s hydrator
       * answers with a viewer-safe payload that has already had `showProgress` and the
       * offering rules applied. An anonymous reader — or a block that slipped into a public
       * section under 506(b) — hydrates to `{}`, and `RoundSummaryBlock` renders nothing for
       * it: a "sign in to see the round" placeholder would be exactly the disclosure the
       * refusal exists to prevent.
       */
      if (block.unavailable !== undefined) return <ReferenceBlock block={block} />;
      return <RoundSummaryBlock hydrated={block.data["hydrated"]} />;
    }
    case "document_list":
      return <ReferenceBlock block={block} />;
    default:
      return null;
  }
}

function ReferenceBlock({ block }: { block: RenderedBlock }) {
  if (block.unavailable !== undefined) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <FileText aria-hidden="true" className="size-4" />
        {block.type === "metric_grid"
          ? m.content_block_metrics_unavailable()
          : block.type === "round_summary"
            ? m.content_block_round_unavailable()
            : m.content_block_documents_unavailable()}
      </div>
    );
  }
  // `document_list` still has no renderer of its own (E1.3's gap): show the raw payload until
  // it does. `metric_grid` reaches here only when the module is off, i.e. with no payload.
  return (
    <pre className="overflow-x-auto rounded-lg border p-4 text-xs">
      {JSON.stringify(block.data["hydrated"] ?? null, null, 2)}
    </pre>
  );
}

export function canUsePublic(settings: ContentSettingsLike | undefined): boolean {
  return settings?.allowPublicSections === true;
}
