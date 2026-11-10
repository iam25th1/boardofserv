# Google verification

What the owner does in Google Cloud Console so boardofserv's Google sign-in
stops showing "Google hasn't verified this app" and works for everyone, not
only the listed test users. Nothing here is done by code, and no Google
setting was changed when this was written.

Google calls the console section **Google Auth Platform**: Branding,
Audience, Clients, Data Access and Verification Center. Google's own help
pages are linked at the end.

## What the app asks for, and why

| Scope | What it is | Why boardofserv needs it |
|---|---|---|
| `openid` | Sign-in basics | To know which Google account was connected |
| `email` | The account's email address | Shown on Connections, so you can see which account an agent uses |
| `https://www.googleapis.com/auth/spreadsheets` | See, edit, create and delete Google Sheets | Agents read the tabs you give them and write their results back |

`spreadsheets` is a **sensitive** scope: Google reviews it (a written reason
and a demo video) before the app can leave Testing for everyone. It is not
a restricted scope, so no security assessment is needed.

The scopes are set in `src/lib/google/oauth.ts` (`SCOPES`); the redirect is
`https://boardofserv.25th.dev/api/connections/google/callback`.

A narrower option for later: `drive.file` (not sensitive) reaches only files
a person picks with Google Picker. boardofserv connects a sheet by its
pasted link, which `drive.file` can't reach, so it asks for `spreadsheets`.
Google may suggest `drive.file` in its review; switching means adding the
Picker to the setup flow.

## What the app already has

- A public home page, https://boardofserv.25th.dev/, that says what
  boardofserv is and does, with no sign-in needed, and links to the data
  page in its footer ("Your data").
- The data page, https://boardofserv.25th.dev/privacy (titled "Your
  data"): what is kept, what it is used for, which services get what, a
  Google Sheets section (what is read, that rows go only to the AI model
  that runs the job, that nothing is used for anything else, shown to other
  people or used to train AI models, and that boardofserv follows Google's
  Limited Use requirements), who sees what, and how to have it deleted.
- The beta notes, https://boardofserv.25th.dev/terms (titled "Using the
  beta").
- A notice right before the consent screen, on Connections and in setup:
  what Google will ask for, where the rows go, and a link to "Your data".
- The app's name everywhere: **boardofserv**.
- A 120 by 120 logo: `public/brand/logo-120.png` (live at
  https://boardofserv.25th.dev/brand/logo-120.png once deployed; its source
  is `docs/brand/logo.svg`).

Google's documents call the data page a "privacy policy". Its name on the
site is "Your data"; what Google checks is what the page says, where it
lives and that the home page and consent screen link to the same address.

## Steps

### 1. Before you start

1. Deploy this branch, so the home page, "Your data" and the logo are live.
2. Verify the domain **25th.dev** in Google Search Console
   (https://search.google.com/search-console), signed in as an owner or
   editor of the Google Cloud project. Google checks the domain of the home
   page, the data page and the redirect against it.
3. In **Clients**, keep only the production web client (redirect
   `https://boardofserv.25th.dev/api/connections/google/callback`). Google's
   review covers every client in the project: move a development client
   (localhost) to a separate project first.

### 2. Branding

Google Auth Platform, **Branding**:

| Field | Value |
|---|---|
| App name | `boardofserv` |
| User support email | the owner's own address (or a Google Group they manage) |
| App logo | `public/brand/logo-120.png` |
| Application home page | `https://boardofserv.25th.dev/` |
| Application privacy policy link | `https://boardofserv.25th.dev/privacy` |
| Application terms of service link | `https://boardofserv.25th.dev/terms` (optional) |
| Authorized domains | `25th.dev` |
| Developer contact email | the owner's address |

Save, then **Verify branding**. It checks automatically within minutes,
then a person may look within two or three business days. Once it says
verified, **Publish branding** (within seven days).

### 3. Audience

Google Auth Platform, **Audience**: user type **External**. Publishing
status: move from **Testing** to **In production**. (In Testing only listed
test users can connect, and their access lasts seven days.)

### 4. Data Access

Google Auth Platform, **Data Access**: add the three scopes above (they may
be there already). For `spreadsheets`, paste the justification below and
the demo video link.

**Scope justification (ready to paste):**

> boardofserv lets a person set up small AI agents that work on their own
> Google Sheets. While setting up an agent, the person picks one tab of one
> spreadsheet for each thing the agent works on, for example a stock list
> or a list of enquiries. The agent reads the rows of those tabs to decide
> what to do, and writes its results back to them, adding rows or replacing
> a tab's contents. It does this on a schedule the person sets, often while
> they are away, so it needs to both read and write cell values through the
> Sheets API; spreadsheets.readonly is not enough, because writing results
> back is the point. boardofserv calls the API only on the spreadsheets and
> tabs the person chose, and they can see, change or remove that choice at
> any time, or disconnect Google, which revokes access. People connect a
> sheet they already use by pasting its link, which drive.file cannot
> reach. The rows an agent reads are sent only to the AI model that makes
> that agent's decisions, only to do that job, and kept in that job's log
> for the person to see. They are never sold, used for ads, shown to other
> people, or used to train AI models. The openid and email scopes show the
> person which Google account an agent is using.

### 5. The demo video

Record it on the live site, in English, and upload it to YouTube as
**Unlisted**. Narrate or caption what each part shows.

1. The home page, https://boardofserv.25th.dev/, signed out: what
   boardofserv is. Scroll to the footer, open "Your data", and show its
   Google Sheets section.
2. Sign in with the email code.
3. Rent or make an agent that uses Google Sheets and start its setup (or
   open Connections). Show the notice above "Connect Google".
4. Click **Connect Google**. On accounts.google.com, zoom into the address
   bar to show `client_id=`; cut to the Console's Clients page showing the
   same client ID.
5. Show the account chooser and the whole consent screen: the name
   boardofserv, the Sheets permission and the email permission. Continue.
6. Back in the app: Connections shows "connected as name@gmail.com" (the
   email scope in use).
7. In setup, paste a sheet's link and pick a tab, with that sheet open
   beside it.
8. Run a test. The job's log shows the rows it read (reading).
9. Switch to the sheet: the rows the agent added (writing). Show that other
   tabs are untouched.
10. On Connections, disconnect Google; then show
    https://myaccount.google.com/permissions no longer lists boardofserv.

### 6. Submit

Verification Center: check that branding is verified and published, then
submit the data access request. Google says a sensitive scope review can
take up to about ten days, and may come back with questions by email to
the developer contact.

## While it's waiting

Nothing changes for people already connected. New people outside the test
users still see the "unverified app" warning until Google approves.

## Google's pages

- Sheets scopes: https://developers.google.com/workspace/sheets/api/scopes
- Sensitive scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Brand verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- Branding fields: https://support.google.com/cloud/answer/15549049
- Data access: https://support.google.com/cloud/answer/15549135
- Home page and privacy page requirements: https://support.google.com/cloud/answer/13464321 and https://support.google.com/cloud/answer/13806988
- Demo video: https://support.google.com/cloud/answer/13804565
- Workspace user data (Limited Use): https://developers.google.com/workspace/workspace-api-user-data-developer-policy
