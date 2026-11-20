import Link from "next/link";
import { config } from "@/lib/config";
import { ISSUES_URL, REPOSITORY_URL } from "@/lib/project-links";

const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
const NOTICE_URL = `${REPOSITORY_URL}/blob/main/NOTICE`;

/**
 * These terms are written for software that a person runs on their own
 * computer with their own keys, not for a hosted service: nothing is sold,
 * there is no company between the person and their data, and no account with
 * the project exists. The sentences about who runs a copy, where data lives and
 * who is billed are claims about this repository's design. If a deployment of
 * it is ever offered to other people, these terms are not enough for it and
 * must be rewritten by whoever runs it.
 */
export default function TermsPage() {
  const providers = config.services.aiProviders.join(", ");

  return (
    <main className="prose dark:prose-invert container mx-auto max-w-3xl py-10">
      <h1>{config.policies.terms.title}</h1>
      {config.policies.terms.lastUpdated ? (
        <p>
          <strong>Last updated:</strong> {config.policies.terms.lastUpdated}
        </p>
      ) : null}

      <p>
        {config.appName} is free, open-source software that you run yourself. It
        is not a hosted service: nothing is sold, and no one at the project sits
        between you and your data. These terms say what that means.
      </p>

      <h2>1. Who runs this copy</h2>
      <p>
        The person who installed this copy, the operator, runs it on their own
        computer or server, with their own database and API keys. The operator
        decides who can sign in and can read everything stored in it. If someone
        else runs the copy you are using, ask them how they handle it. The{" "}
        {config.organization.name} maintainers do not run or host any copy and
        do not see what is entered in one.
      </p>

      <h2>2. What it does</h2>
      <p>
        {config.appName} helps a founder test an idea before building it: an
        eight-phase conversation whose gates refuse to advance without evidence,
        a research step that collects public demand signals, and an export of
        the validated project. It uses AI models from {providers} through API
        keys that the operator supplies.
      </p>

      <h2>3. Licence and warranty</h2>
      <p>
        {config.appName} is licensed under the{" "}
        <a href={LICENSE_URL}>Apache License 2.0</a>. It is a fork of ChatJS,
        and the attribution is in the <a href={NOTICE_URL}>NOTICE</a> file. As
        sections 7 and 8 of that licence say, the software is provided &quot;as
        is&quot;, without warranties of any kind, and to the extent the law
        allows no contributor is liable for damages that arise from using it.
      </p>

      <h2>4. Results are not advice</h2>
      <p>
        AI output can be wrong, and a passed gate is not a prediction that an
        idea will succeed. Research results come from public sources and can be
        incomplete or out of date. Simulated personas are not evidence. Nothing
        in {config.appName} is legal, financial or professional advice; check
        what matters before you rely on it.
      </p>

      <h2>5. AI providers and public sources</h2>
      <p>
        The operator&apos;s API keys connect the app to {providers}. The{" "}
        <Link href="/privacy">Privacy Policy</Link> lists what is sent to them.
        Their own terms and privacy policies apply to that text, and they bill
        the operator, not the project, for it. The research step also reads
        public websites, whose terms apply to that use.
      </p>

      <h2>6. No payments</h2>
      <p>
        {config.appName} has no plans, subscriptions, paid tiers or payment
        processing, and the project charges nothing. The only costs are what the
        operator&apos;s AI providers charge for the operator&apos;s own keys.
      </p>

      <h2>7. Using it responsibly</h2>
      <p>
        Follow the law and the usage policies of the AI providers and public
        sources your copy connects to. If you run a copy for other people, you
        are responsible for what they do with it and for the data it holds.
      </p>

      <h2>8. Changes</h2>
      <p>
        These terms change with the software. The date at the top shows the last
        change.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about the software:{" "}
        {config.organization.contact.legalEmail ?? (
          <a href={ISSUES_URL}>{ISSUES_URL}</a>
        )}
        . The maintainers cannot help with a copy that someone else runs.
      </p>
    </main>
  );
}
