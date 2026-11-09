import Link from "next/link";
import { Drawing, SpineMark } from "./Drawing";
import { HeroMachine } from "./HeroMachine";
import { OpenApp } from "./OpenApp";
import { PublicFooter, PublicHeader } from "./PublicChrome";
import styles from "./Landing.module.css";

// The public front page. It reads like one of its agents' runs: a chalk
// spine down the page with a mark for each part (the same square, diamond
// and circle as a job's timeline), the words beside it, and a small chalk
// drawing that draws itself once as it comes into view. Every claim on it
// is true of the product as it is.

export function Landing() {
  return (
    <div className={styles.page}>
      <PublicHeader />
      <main>
        <section className={styles.hero} aria-labelledby="hero-h">
          <div className={styles.heroText}>
            <h1 id="hero-h">Small agents that do one job for you, every week.</h1>
            <p className={styles.lede}>
              Rent an agent from the board by the week, or describe a job in plain words and earn whenever someone rents what you made. It runs on its own, and
              asks before it spends.
            </p>
            <OpenApp />
          </div>
          <div className={styles.heroArt}>
            <HeroMachine variant="wide" />
            <HeroMachine variant="tall" />
          </div>
        </section>

        <div className={styles.spine}>
          <Part mark="diamond" id="renters" title="For anyone who needs an agent" art={<RentArt />}>
            <ul className={styles.points}>
              <li>
                <strong>Find one on the board.</strong> Each shows what it does, the steps it takes, what it connects to and what it costs a week.
              </li>
              <li>
                <strong>Rent it by the week</strong>, in USDC from your wallet balance. Cancel any time: it stops at the end of the week you paid for.
              </li>
              <li>
                <strong>It works on its own:</strong> on a schedule, when a value it watches changes, or when you message it on Telegram.
              </li>
              <li>
                <strong>It asks before it spends.</strong> Over your limit, it waits for your yes, with a button in Telegram.
              </li>
            </ul>
          </Part>

          <Part mark="square" id="makers" title="For makers" art={<MakerArt />}>
            <ul className={styles.points}>
              <li>
                <strong>Describe a job in plain words.</strong> SERV plans the steps, Dolphin writes the code for each one, and SERV reviews it before it ever
                runs.
              </li>
              <li>
                <strong>Try it on the test bench</strong> with sample data, then publish it with a weekly price.
              </li>
              <li>
                <strong>Earn every week</strong> someone rents it: 90% of each week&apos;s rent is yours.
              </li>
            </ul>
          </Part>

          <Part mark="circle" id="how" title="How it works">
            <ol className={styles.steps}>
              <li>
                <span className={styles.stepNo}>1</span>
                <div>
                  <strong>Pick an agent, or describe one.</strong>
                  <p>Browse the board, or tell the chat what you need done.</p>
                </div>
              </li>
              <li>
                <span className={styles.stepNo}>2</span>
                <div>
                  <strong>Set it up in a few minutes.</strong>
                  <p>Answer its questions, link Telegram, connect Google and pick your sheet, set your limits, then run a test.</p>
                </div>
              </li>
              <li>
                <span className={styles.stepNo}>3</span>
                <div>
                  <strong>It runs, and asks.</strong>
                  <p>It does its job on its own and asks you in Telegram before anything over your limits.</p>
                </div>
              </li>
            </ol>
          </Part>

          <Part mark="ring" id="requests" title="Can't find it? Ask for it." art={<RequestArt />}>
            <p className={styles.para}>
              Post what you need on the request board: what it should do, what it should connect to and what you&apos;d pay a week. Others add &ldquo;me
              too&rdquo;. Makers offer agents they&apos;ve built; accept one and it&apos;s yours to rent.
            </p>
            <Link className={styles.partLink} href="/app/requests">
              See the request board
            </Link>
          </Part>

          <Part mark="square" id="safety" title="Your rules, your data" art={<SafetyArt />}>
            <ul className={styles.points}>
              <li>
                <strong>Your rules.</strong> You set its limits when you set it up, and change them any time.
              </li>
              <li>
                <strong>Approvals.</strong> Before any spending that would take a job&apos;s total, or the day&apos;s, over your limit, it waits for your yes.
              </li>
              <li>
                <strong>Spending limits.</strong> A daily cap on what its model calls may cost, and daily caps on the pages, searches and sheet calls it makes.
              </li>
              <li>
                <strong>Secret recipes.</strong> An agent&apos;s code and prompts stay with its maker. Makers see how their agent ran for you, never what it saw.
              </li>
              <li>
                <strong>Your connections stay yours.</strong> Your Telegram chat and Google access are kept encrypted, and an agent reaches only the sheet tabs
                you give it.
              </li>
            </ul>
          </Part>
        </div>

        <section className={styles.powered} aria-labelledby="powered-h">
          <h2 id="powered-h">Powered by</h2>
          <ul>
            <li>
              <strong>SERV Reasoning</strong> plans, decides and reviews
            </li>
            <li>
              <strong>Dolphin</strong> writes the code
            </li>
            <li>
              <strong>Base</strong> and <strong>USDC</strong> for payments
            </li>
            <li>
              <strong>Telegram</strong> and <strong>Google Sheets</strong> where your agents meet you
            </li>
          </ul>
        </section>

        <section className={styles.last} aria-labelledby="last-h">
          <h2 id="last-h">Give one job away.</h2>
          <OpenApp quiet />
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

function Part({ mark, id, title, art, children }: { mark: "square" | "diamond" | "circle" | "ring"; id: string; title: string; art?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={styles.part} aria-labelledby={`${id}-h`}>
      <div className={styles.markCol}>
        <SpineMark kind={mark} />
      </div>
      <div className={styles.partText}>
        <h2 id={`${id}-h`}>{title}</h2>
        {children}
      </div>
      {art && <div className={styles.partArt}>{art}</div>}
    </section>
  );
}

// A board of agents, one pinned and ticked: rented for a week.
function RentArt() {
  return (
    <Drawing label="A board of agents, one of them pinned: rented for a week." viewBox="0 0 320 210">
      <rect data-draw x="10" y="10" width="300" height="170" rx="8" />
      <rect data-draw x="30" y="32" width="76" height="56" rx="5" />
      <rect data-draw x="122" y="32" width="76" height="56" rx="5" />
      <rect data-draw x="214" y="32" width="76" height="56" rx="5" />
      <rect data-draw x="30" y="104" width="76" height="56" rx="5" />
      <rect data-draw x="122" y="104" width="76" height="56" rx="5" className={styles.bold} />
      <path data-draw d="M40 50 H90 M40 62 H78 M132 50 H182 M132 62 H170 M224 50 H274 M224 62 H262 M40 122 H90 M40 134 H70 M132 122 H182 M132 134 H174" className={styles.thin} />
      <circle data-draw cx="160" cy="104" r="5" className={styles.bold} />
      <path data-draw d="M178 150 L186 158 L200 140" className={styles.bold} />
      <text data-note x="214" y="140" className={styles.handSm}>
        rented
      </text>
      <text data-note x="214" y="160" className={styles.handSm}>
        for a week
      </text>
    </Drawing>
  );
}

// A job in words becomes three steps, and the rent comes back each week.
function MakerArt() {
  return (
    <Drawing label="A job described in words becomes three steps; each week's rent comes back to its maker." viewBox="0 0 320 210">
      <path data-draw d="M18 40 H118 Q126 40 126 48 V82 Q126 90 118 90 H58 L42 104 V90 H18 Q10 90 10 82 V48 Q10 40 18 40 Z" />
      <path data-draw d="M24 56 H110 M24 72 H90" className={styles.thin} />
      <path data-draw d="M136 66 H160 M154 60 L160 66 L154 72" />
      <rect data-draw x="170" y="52" width="28" height="28" rx="3" />
      <path data-draw d="M226 50 L242 66 L226 82 L210 66 Z" />
      <circle data-draw cx="276" cy="66" r="14" />
      <path data-draw d="M198 66 H210 M242 66 H262" className={styles.thin} />
      <path data-draw d="M276 90 V130 M270 124 L276 130 L282 124" />
      <ellipse data-draw cx="276" cy="148" rx="22" ry="7" />
      <path data-draw d="M254 148 V160 Q276 172 298 160 V148 M254 160 V172 Q276 184 298 172 V160" />
      <text data-note x="10" y="128" className={styles.handSm}>
        a job, in words
      </text>
      <text data-note x="160" y="200" className={styles.handSm}>
        90% of the rent, yours
      </text>
    </Drawing>
  );
}

// A note pinned to a board, three "me too" ticks, and an offer on a string.
function RequestArt() {
  return (
    <Drawing label="A request pinned to the board, with three me-too ticks and a maker's offer attached." viewBox="0 0 320 210">
      <path data-draw d="M40 30 H190 V150 H40 Z" />
      <circle data-draw cx="115" cy="30" r="5" className={styles.bold} />
      <path data-draw d="M56 58 H174 M56 76 H160 M56 94 H168" className={styles.thin} />
      <path data-draw d="M58 122 V136 M68 122 V136 M78 122 V136" className={styles.bold} />
      <path data-draw d="M190 100 C226 100 226 140 252 140" className={styles.dashed} />
      <rect data-draw x="252" y="118" width="58" height="44" rx="5" />
      <path data-draw d="M262 134 H300 M262 146 H288" className={styles.thin} />
      <text data-note x="56" y="180" className={styles.handSm}>
        +3 me too
      </text>
      <text data-note x="236" y="190" className={styles.handSm}>
        an offer
      </text>
    </Drawing>
  );
}

// A gate with a question on it, a dial set to a limit, and a sealed recipe.
function SafetyArt() {
  return (
    <Drawing label="A gate that asks first, a dial set to your limit, and a recipe kept sealed." viewBox="0 0 320 210">
      <path data-draw d="M20 160 V60 M110 160 V60 M20 90 H110 M20 130 H110" />
      <circle data-draw cx="65" cy="62" r="16" className={styles.dashed} />
      <path data-draw d="M59 56 C59 49 71 49 71 56 C71 61 65 61 65 66 M65 71 V72" className={styles.thin} />
      <path data-draw d="M140 140 A50 50 0 0 1 240 140" />
      <path data-draw d="M190 140 L218 108" className={styles.bold} />
      <path data-draw d="M150 128 L156 124 M190 92 V100 M230 128 L224 124" className={styles.thin} />
      <rect data-draw x="258" y="96" width="44" height="56" rx="4" />
      <path data-draw d="M268 96 V84 Q268 72 280 72 Q292 72 292 84 V96" />
      <path data-draw d="M270 116 H290 M270 128 H284" className={styles.thin} />
      <text data-note x="40" y="190" className={styles.handSm}>
        asks first
      </text>
      <text data-note x="164" y="170" className={styles.handSm}>
        your limit
      </text>
      <text data-note x="250" y="180" className={styles.handSm}>
        kept secret
      </text>
    </Drawing>
  );
}
