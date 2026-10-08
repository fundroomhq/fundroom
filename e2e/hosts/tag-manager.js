/*
 * The tag manager from hell: the third-party marketing snippet that is on every real host page,
 * written as if its author wanted the investor data. It is the reason design/08 §2 puts document
 * viewing inside a cross-origin iframe in every mode — host-page JS can read anything in the host
 * DOM, and Shadow DOM isolates CSS, not JS, so the iframe boundary is the only real barrier the
 * browser offers.
 *
 * Everything it manages to obtain goes into `window.__hostile`, and the test asserts that record
 * is empty. Nothing here is subtle or clever on purpose: these are the four things such a script
 * would actually try, and every one of them must come back with nothing.
 */
(() => {
  const report = {
    /** The host page's own cookies. Must never contain the portal's session cookie. */
    cookie: null,
    /** Anything read out of the frame's document. */
    frameDom: null,
    frameDomError: null,
    /** The frame's current URL, which would leak the visitor's position inside the portal. */
    frameLocation: null,
    frameLocationError: null,
    /** The portal API, called with credentials from the host origin. */
    apiStatus: null,
    apiBody: null,
    apiError: null,
    /** The embed document itself, fetched rather than framed. */
    documentStatus: null,
    documentBody: null,
    documentError: null,
    /** Bridge messages the frame sent us. Allowed to exist; asserted to carry no content. */
    received: [],
    /** How the frame reacted to garbage. */
    stillFramed: null,
    done: false,
  };
  window.__hostile = report;

  window.addEventListener("message", (event) => {
    if (event.origin !== "https://portal.test") return;
    report.received.push(event.data);
  });

  function attempt(iframe) {
    report.cookie = document.cookie;

    // 1. Read the frame's DOM. Cross-origin, so `contentDocument` is null and touching
    //    `contentWindow.document` throws — but a script cannot know that without trying.
    try {
      const doc = iframe.contentDocument;
      report.frameDom = doc === null ? null : doc.body.innerHTML.slice(0, 500);
      if (doc === null)
        report.frameDom = iframe.contentWindow.document.body.innerHTML.slice(0, 500);
    } catch (error) {
      report.frameDomError = String(error);
    }

    // 2. Read where the visitor is inside the portal.
    try {
      report.frameLocation = iframe.contentWindow.location.href;
    } catch (error) {
      report.frameLocationError = String(error);
    }

    // 3. Call the portal's API with the visitor's credentials. This is the host-XSS-forges-API-
    //    calls threat: if the embed origins were ever added to the CORS allow-list, this line
    //    would come back with the signed-in investor's identity.
    fetch("https://portal.test/embed/acme-inc/api/v1/me", { credentials: "include" })
      .then((res) => {
        report.apiStatus = res.status;
        return res.text();
      })
      .then((text) => {
        report.apiBody = text.slice(0, 500);
      })
      .catch((error) => {
        report.apiError = String(error);
      });

    // 4. Fetch the embed document itself rather than framing it — `frame-ancestors` is a framing
    //    control and says nothing about `fetch`, so the refusal here has to come from CORS.
    fetch("https://portal.test/embed/acme-inc", { credentials: "include" })
      .then((res) => {
        report.documentStatus = res.status;
        return res.text();
      })
      .then((text) => {
        report.documentBody = text.slice(0, 500);
      })
      .catch((error) => {
        report.documentError = String(error);
      });

    // 5. Post garbage at the frame. The host page is allow-listed, so the child *will* look at
    //    these — being able to drive the portal is the contract. What it must not do is act on a
    //    malformed one, throw, or follow `//evil.example` out of the portal.
    const garbage = [
      "not an object",
      42,
      { v: 1 },
      { v: 1, type: "navigate" },
      { v: 1, type: "navigate", payload: { path: "//evil.example/" } },
      { v: 1, type: "navigate", payload: { path: "https://evil.example/" } },
      { v: 2, type: "navigate", payload: { path: "/updates" } },
      { v: 1, type: "not-a-real-type", payload: {} },
      { v: 1, type: "theme", payload: { tokens: "everything" } },
    ];
    for (const message of garbage) {
      try {
        iframe.contentWindow.postMessage(message, "*");
      } catch (_error) {
        /* a failed post is a failed attack; keep going */
      }
    }

    window.setTimeout(() => {
      report.stillFramed = document.querySelector("[data-seed-host-portal] iframe") !== null;
      report.done = true;
    }, 1500);
  }

  var waited = 0;
  var timer = window.setInterval(() => {
    var iframe = document.querySelector("[data-seed-host-portal] iframe");
    waited += 100;
    if (iframe !== null && iframe.contentWindow !== null) {
      window.clearInterval(timer);
      attempt(iframe);
    } else if (waited > 15000) {
      window.clearInterval(timer);
      report.done = true;
    }
  }, 100);
})();
