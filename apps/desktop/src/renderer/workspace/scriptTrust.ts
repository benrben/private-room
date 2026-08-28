/** The one place the script-run consent card's trust sentences are written.
 *
 * Kept out of the JSX (and free of imports) so the wording is a value a test can
 * assert on: this card is the ONLY thing standing between "run a word counter"
 * and arbitrary code on the user's Mac, so it has to describe the real trust
 * class rather than a comfortable subset of it.
 *
 * What the run actually gets (`script_run::execute_script_in_workspace`): a
 * cleared environment except PATH/HOME/TMPDIR, `HOME` pointing at the user's
 * REAL home directory, no sandbox profile of any kind, and the network. The
 * card used to name the internet and the unencrypted workspace but not the
 * home folder, so approving a "word counter" granted far more than the card
 * described.
 */

/** The sentence naming the powers the run gets. Room files it reads are listed
 * separately on the card (they are per-script); these are true of every run. */
export const SCRIPT_POWERS =
  "it can reach the internet, and it runs with no sandbox — it can read and " +
  "change files anywhere in your home folder, like any app you launch.";

/** The sentence naming where the room's own files go while it runs. */
export const SCRIPT_WORKSPACE_NOTE =
  "While it runs, the room files it uses are placed in a temporary folder " +
  "outside the room's encryption.";
