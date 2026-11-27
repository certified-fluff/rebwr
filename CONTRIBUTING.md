# Contributing

Thanks for taking the time to contribute! Issues and pull requests are both
welcome.

## Getting set up

```bash
git clone <your-fork-url> ReBWR
cd ReBWR
npm install
cp .env.example .env    # Windows: copy .env.example .env
npm start
```

The dashboard then runs on <http://localhost:3000>. You do not need real API
keys to develop — leaving `RECAPTCHA_SECRET_KEY` empty disables the captcha gate
so you can work on the UI unimpeded.

## Before you open a pull request

1. **Keep it focused.** One logical change per pull request; split unrelated
   cleanups into their own.
2. **Match the existing style.** No build step, no bundler, no new frontend
   dependencies — `public/` is intentionally a plain static bundle. The backend
   uses 2-space indentation, semicolons and `const`/`let` in CommonJS.
3. **Verify it runs.** Start the server and confirm the page loads, the stats bar
   populates and `/health` returns `"status": "ok"`. If you touched the WebSocket
   path, watch the browser console for reconnect loops.
4. **Keep secrets and local experiments out.** `.env` and `exp/` are git-ignored;
   never force-add them, and never hardcode keys, tokens or production hostnames.
5. **Describe the change.** In the pull request, explain the problem, the fix and
   anything a reviewer should test by hand.

## Reporting bugs

Please include:

- what you expected and what actually happened,
- exact steps to reproduce,
- your Node.js version and OS,
- any relevant server or browser-console output (redact secrets and IPs).

## Reporting security issues

Do **not** open a public issue. Contact the maintainer privately so the problem
can be fixed before it is disclosed.

## License

By contributing, you agree that your contributions are licensed under the
[GNU Affero General Public License v3.0](LICENSE), the same licence that covers
this project.