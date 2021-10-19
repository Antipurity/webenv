You fool.

You thought that this is the directory for the processes that make sure that every component of WebEnv works.

But WebEnv is too modular: WebEnv modules are small enough to be held entirely in mind (and sanity-checked only as needed), so most bugs concern internal state and behavior over time, not the trivially-obvious deterministic behavior. We don't anticipate architectural rewrites, therefore, no unit tests. Just run the Python example with whatever interfaces that your changes have affected, and possibly connect the extension & web page.

This is just the simple test web page to test that plain-web-page `webenv.remote` connections work.

---

Compared to the extension, plain-page connections are inferior in 1.5 ways: cannot survive navigation, and forces users to select the tab among many wrong options that we cannot remove (non-Chromium extensions do that last one too, though).