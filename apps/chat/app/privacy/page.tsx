import Link from "next/link";
import { config } from "@/lib/config";
import { ISSUES_URL } from "@/lib/project-links";

/**
 * This policy is written for software that a person runs on their own
 * computer with their own keys, not for a hosted service. Every sentence is a
 * claim about this repository's design, so keep each one checkable:
 * - "no analytics or telemetry": `instrumentation.ts` registers nothing and no
 *   analytics package is installed;
 * - "stored in the operator's database": chats, facts, documents and sessions
 *   are tables in `lib/db/schema.ts`, and nothing is written elsewhere;
 * - "sent to the AI providers": `config.services.aiProviders`, under the
 *   operator's own keys (`chat.config.ts`);
 * - "public sources": the research sidecar's source list
 *   (`apps/research/README.md`).
 * If a deployment of this app is ever offered to other people, this page is not
 * enough for it and must be rewritten by whoever runs it.
 */
export default function PrivacyPage() {
  const providers = config.services.aiProviders.join(", ");

  return (
    <main className="prose dark:prose-invert container mx-auto max-w-3xl py-10">
      <h1>{config.policies.privacy.title}</h1>
      {config.policies.privacy.lastUpdated ? (
        <p>
          <strong>Last updated:</strong> {config.policies.privacy.lastUpdated}
        </p>
      ) : null}

      <p>
        {config.appName} runs on a computer that its operator controls, the
        person who installed it. The {config.organization.name} maintainers run
        no server for it, collect nothing from it and receive no data from it.
        This page says where your data goes when you use a copy.
      </p>

      <h2>What is stored, and where</h2>
      <p>
        Everything you enter and everything {config.appName} produces is stored
        in the database the operator configured, which by default is a database
        on the same computer. That covers:
      </p>
      <ul>
        <li>
          Your chats and messages, the project facts and evidence taken from
          them, research results, documents and exports.
        </li>
        <li>
          Your sign-in details: name and email address, or the profile that your
          sign-in provider returns.
        </li>
        <li>
          Sign-in sessions, which can record the IP address and browser of the
          device that signed in.
        </li>
      </ul>
      <p>
        The operator can read all of it. Deleting a chat in the app removes it
        from that database, and the operator can remove everything by deleting
        the database. The maintainers cannot see or delete it.
      </p>

      <h2>What is sent to AI providers</h2>
      <p>
        To work, {config.appName} sends text to {providers}, using the
        operator&apos;s own API keys: your messages, along with the project
        facts, documents and research text that give them context. Each
        provider&apos;s own privacy policy and retention terms govern what it
        does with that text. Check them, and the settings of the operator&apos;s
        account with each.
      </p>

      <h2>What is sent to public sources</h2>
      <p>
        The research step turns your idea into short search queries and sends
        them to public sources: Hacker News and a web search (a SearXNG that the
        operator runs, or DuckDuckGo) by default, and GitHub or a public archive
        of Reddit posts when the operator turns those on. Those sites see the
        queries and the operator&apos;s IP address, not your account.
      </p>

      <h2>Cookies</h2>
      <p>
        {config.appName} sets only the cookies it needs to work: your sign-in
        session, an anonymous session when you use it without signing in, and
        your sidebar and model choices. It sets no advertising or tracking
        cookies.
      </p>

      <h2>No analytics</h2>
      <p>
        {config.appName} has no analytics, tracking or telemetry of its own, and
        it does not report usage to the maintainers.
      </p>

      <h2>Your choices</h2>
      <p>
        Because the data sits in the operator&apos;s database, the operator is
        the one who can give you a copy of it, correct it or delete it. If you
        are the operator, that includes the people you let sign in.
      </p>

      <h2>Children</h2>
      <p>
        {config.appName} is a tool for people building products and is not
        directed to children under {config.legal.minimumAge}.
      </p>

      <h2>Changes</h2>
      <p>
        This policy changes with the software. The date at the top shows the
        last change. The <Link href="/terms">Terms of Service</Link> explain who
        runs a copy and what the licence allows.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about the software:{" "}
        {config.organization.contact.privacyEmail ?? (
          <a href={ISSUES_URL}>{ISSUES_URL}</a>
        )}
        . The maintainers cannot answer for a copy that someone else runs.
      </p>
    </main>
  );
}
