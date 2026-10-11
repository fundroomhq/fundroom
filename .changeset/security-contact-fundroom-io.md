---
"@fundroom/server": patch
"@fundroom/config": patch
---

Report vulnerabilities through GitHub private vulnerability reporting (<https://github.com/fundroomhq/fundroom/security/advisories/new>) or to `security@fundroom.io`. FundRoom's domain is `fundroom.io`; the `.com` of the same name belongs to someone else, so do not send reports there, and disregard the address given in earlier release notes. The default `/.well-known/security.txt` now lists the GitHub advisory form first and `mailto:security@fundroom.io` second (`SECURITY_TXT_CONTACT` still replaces both). The update check's default index moved to `https://releases.fundroom.io/index.json`; an install that set `UPDATE_CHECK_URL` to the old host should unset it or point it at the new one.
