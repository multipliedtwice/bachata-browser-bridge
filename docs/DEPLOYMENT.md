# Deployment

This repository builds the Bridge release artifacts. The Bachata VS Code
repository deploys both marketplaces from one verified release set.

1. Run `Release gates` on Ubuntu, macOS and Windows.
2. Run `Release artifact`. It checks types, lint, format, coverage and packaging.
3. Supply its successful run ID to the Extension's `Paired release verification`.
4. Complete exact-artifact acceptance. Human decides SHIP.
5. Run Extension `Publish marketplaces` at the verified commit; target `bridge`
   for Bridge-only publication or recovery.

Extension `docs/DEPLOYMENT.md` owns credentials, environment and release sequence.
Store OAuth belongs in GitHub secrets. Browser sign-in does not authenticate CI.
Chrome item, listing, privacy and visibility must exist before API publication.
See [Chrome API setup](https://developer.chrome.com/docs/webstore/using-api).

Keep exact verified ZIP until acceptance and deployment finish. Source exports
carry README artwork but no builds, dependencies, caches or archived ZIPs. The
installable ZIP contains runtime files and required licenses only.

Submission is not approval. `PENDING_REVIEW` means Chrome review remains open.
Hosted workflow and store acceptance remain unverified until actually run.
