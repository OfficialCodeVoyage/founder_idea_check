# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**
   (<https://github.com/OfficialCodeVoyage/founder_idea_check/security/advisories/new>).
3. Describe what you found.

Do not open a public issue, pull request or discussion for a vulnerability, and do not post
exploit details anywhere public until a fix has shipped. Only the maintainers can read a private
report.

A useful report says:

- what is affected (the app in `apps/chat`, the research sidecar in `apps/research`, or a shared
  package) and the commit or branch you tested;
- the steps to reproduce it, or a proof of concept;
- what an attacker gains (read another user's project, bypass the phase gate, run code, reach an
  internal address, leak a key).

If you found a secret (an API key, a token, a password) in the repository or its history, report
it the same way and do not use it.

## What to expect

This is a small, maintainer-run project. There is no service-level agreement. The maintainers aim
to acknowledge a report within seven days, to tell you whether they consider it a vulnerability,
and to credit you in the advisory if you want that. Please give them a reasonable time to fix the
problem before you disclose it.

## Supported versions

Only the latest commit on the `main` branch is supported. There are no tagged releases yet. Fixes
land on `main`.

## Scope

In scope: the code in this repository, including the research sidecar and the build and CI
configuration.

Out of scope:

- Problems in upstream ChatJS that do not depend on the changes made here: report those to
  [ChatJS](https://github.com/FranciscoMoretti/chat-js).
- Problems in a dependency or a third-party service: report them to that project or vendor. If this
  repository uses the dependency in a way that makes the problem worse, tell us.
- A deployment you run yourself with weak settings (a guessable `AUTH_SECRET`, a database open to
  the internet, the dev-only login enabled in production).
- Findings that need physical access to a machine, social engineering, or denial of service by
  sheer traffic volume.

## Good-faith research

If you act in good faith (you test only against your own local copy, you do not touch other
people's data, and you report what you find privately), the maintainers will not take action
against you.
