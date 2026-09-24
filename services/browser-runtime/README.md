# Isolated Browser Agent

SET 9 runs Playwright in a dedicated Node process. It launches a fresh Microsoft Edge process with
an isolated temporary profile by default; a named persistent profile is used only after explicit
opt-in. Jupiter never imports the user's regular browser profile.

Web content is untrusted data. Semantic selectors are preferred, downloads remain in a managed
directory until verified, uploads use one exact approved file, and unexpected cross-origin
navigation pauses the session. Raw page text, form values, cookies, HTML, and screenshots are not
stored in browser action history.
