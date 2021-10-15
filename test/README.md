You fool.

You thought that this is the directory for the processes that make sure that every component of WebEnv works.

But tests would have little purpose: WebEnv is too modular, and each module changes very rarely and can just be held in mind when it does (only requiring a few sanity checks at the end to make sure it works).

This is just the simple test web page to test that plain-web-page `webenv.remote` connections work.

---

Compared to the extension, plain-page connections are inferior in 1.5 ways: cannot survive navigation, and forces users to select the tab among many wrong options that we cannot remove (non-Chromium extensions do that last one too, though).