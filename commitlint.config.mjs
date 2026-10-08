/**
 * Conventional commits for readable history. Versions come from Changesets,
 * not from commit prefixes, so this is a readability rule, not a release rule.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "scope-enum": [
      1,
      "always",
      [
        "repo",
        "config",
        "db",
        "auth",
        "authz",
        "audit",
        "jobs",
        "storage",
        "email",
        "kms",
        "http",
        "api",
        "web",
        "ui",
        "embed",
        "sdk",
        "wp",
        "deploy",
        "docs",
        "ci",
        "deps",
        "release",
      ],
    ],
  },
};
