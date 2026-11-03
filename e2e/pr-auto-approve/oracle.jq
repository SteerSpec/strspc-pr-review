# SPDX-License-Identifier: Apache-2.0
#
# The real-Copilot tier's judge, in jq. copilot.sh imports it.
#
# Two jobs, kept apart:
#
#   probe   classifies one Copilot review body against the shapes Copilot is known
#           to post. A body that fits none is DRIFT: Copilot changed its output, and
#           the action's parser may be judging it wrong. This is what catches drift,
#           because an oracle that knows the same shapes as decide.js would agree
#           with it about a body neither understands, and both would just skip.
#
#   expect  computes the decision the action should have made from what GitHub
#           holds: checks, reviews, inline comment counts. It is written from the
#           documented behaviour and deliberately does not load decide.js, which
#           would test the implementation against itself. It covers the paths the
#           real scenarios can reach: a feature PR to main, no promotion or release.
#
# scripts/pr-auto-approve/oracle.test.js holds both against decide.js on every
# fixture body, so the two cannot drift apart unnoticed.

def unfenced: gsub("```[\\s\\S]*?```"; "");
def trimmed: sub("^\\s+"; "") | sub("\\s+$"; "");

# Labels of the collapsed <summary> sections, tags stripped.
def sections: [match("<summary\\b[^>]*>([\\s\\S]*?)</summary>"; "gi") | .captures[0].string | gsub("<[^>]*>"; "") | trimmed];

# The text of the first heading, without the emoji in front. "" when none.
def verdict: ([match("(?m)^#{1,6}\\s+([^\n]+?)\\s*$") | .captures[0].string] | first // "") | sub("^[^\\p{L}\\p{N}]+"; "");

def known_verdicts: ["Approval recommended", "Changes recommended", "Needs a closer look"];

# Every section label Copilot has used. One outside this list is drift.
def known_section: test("^(What changed in this PR|\\d+ resolved since last review|\\d+ open issues?|\\d+ previously missed issues?|Suppressed comments? \\(\\d+\\)|Comments? suppressed due to low confidence \\(\\d+\\))$"; "i");

# Why Copilot reviewed nothing, from the start of the body. "" for a real review.
def no_review_cause:
  if .state != "COMMENTED" then ""
  else (.body // "" | trimmed) as $b
  | if ($b | test("\\ACopilot encountered an error and was unable to review this pull request\\."; "i")) then "errored"
    elif ($b | test("\\ACopilot was unable to review this pull request because the user who requested the review has reached their quota limit\\."; "i")) then "quota"
    else "" end
  end;

def no_files: (.body // "") | unfenced | test("(?m)^Copilot wasn['’]t able to review any files in this pull request\\."; "i");

def open_issues: [(.body // "") | match("<summary\\b[^>]*>(?:(?!</summary>)[\\s\\S])*?(\\d+)\\s+open issues?\\b"; "i") | .captures[0].string | tonumber] | first // 0;

def suppressed: [(.body // "") | unfenced | match("<summary>\\s*(?:\\*\\*)?\\s*(?:Comments? suppressed due to low confidence|Suppressed comments?)\\s*\\((\\d+)\\)"; "gi") | .captures[0].string | tonumber] | add // 0;

def previously_missed: (.body // "") | test("\\b[1-9]\\d*\\s+previously missed|previously missed\\s*\\((?!0\\))"; "i");

def states_no_open_issues: (.body // "") | unfenced | split("<details") | first | test("(?m)^\\s*\\*\\*No open issues\\*\\*");

def is_overview:
  (.body // "" | unfenced) as $u
  | ($u | test("<!--\\s*ccr-overview\\b[^>]*-->"; "i"))
    or ($u | test("(?m)^#{1,6}\\s.*(Approval recommended|Changes recommended|Needs a closer look)"; "i"))
    or open_issues > 0 or states_no_open_issues;

# {shape, drift: [...], warn: [...]} for one review.
def probe:
  if no_review_cause != "" then {shape: no_review_cause, drift: [], warn: []}
  elif no_files then {shape: "no-files", drift: [], warn: []}
  elif .state == "CHANGES_REQUESTED" then {shape: "changes-requested", drift: [], warn: []}
  else
    (.body // "" | unfenced) as $u
    | (.body // "" | unfenced | verdict) as $v
    | {shape: "overview",
       drift: [
         (if ($u | test("<!--\\s*ccr-overview\\b[^>]*-->"; "i")) then empty else "no ccr-overview marker" end),
         (if (known_verdicts | index($v)) then empty else "unknown verdict heading '\($v)'" end),
         (if states_no_open_issues or open_issues > 0 then empty else "states neither 'No open issues' nor a count of open issues" end),
         ((.body // "") | sections[] | select(known_section | not) | "unknown section '\(.)'")
       ],
       warn: [
         (if ($u | test("<!--\\s*ccr-overview-v2\\s*-->")) then empty else "overview marker is not v2" end)
       ]}
  end;

# Why the body blocks approval, as a regex for the action's reason after
# "latest Copilot review "; "" when it proves the review clean.
def body_blocker($clean_on):
  (.body // "" | unfenced | verdict) as $v
  | if suppressed > 0 then "has \(suppressed) suppressed comment"
    elif is_overview | not then "has no verdict overview"
    elif ($v == "Approval recommended" or ($clean_on == "no-open-issues" and $v == "Needs a closer look")) | not then "has verdict '"
    elif open_issues > 0 then "lists \(open_issues) open issue"
    elif states_no_open_issues | not then "does not state no open issues"
    elif previously_missed then "lists a previously missed issue"
    elif ((.body // "") | sections | map(select(test("^(What changed in this PR|\\d+ resolved since last review)$"; "i") | not)) | length) > 0 then "has section '"
    else "" end;

# Input: {head, failed_check, threshold, clean_on, logins, reviews}, where each
# review carries `comments`, its inline comment count. Output: {decision, reason},
# reason being a regex for the action's logged reason.
def expect:
  . as $in
  | [$in.reviews[] | select(.user.login as $l | $in.logins | index($l))] as $copilot
  | [$copilot[] | select(no_review_cause == "" and .state != "DISMISSED" and .state != "PENDING")] | sort_by(.submitted_at) as $real
  | if $in.failed_check then {decision: "skip", reason: "^failing check: "}
    elif ($real | length) == 0 then {decision: "skip", reason: "^no Copilot review yet"}
    else ($real | last) as $l
    | if $l.state == "CHANGES_REQUESTED" then {decision: "skip", reason: "^latest Copilot review requested changes"}
      elif ([$real[] | select(no_files | not)] | length) >= $in.threshold then {decision: "approved", reason: "^\($in.threshold)-rounds"}
      elif $l.commit_id != $in.head then {decision: "skip", reason: "^latest Copilot review is for an older commit"}
      elif ($l | no_files) then {decision: "skip", reason: "^latest Copilot review says it could not review any files"}
      elif $l.comments > 0 then {decision: "skip", reason: "^latest Copilot review has \($l.comments) comments"}
      else ($l | body_blocker($in.clean_on)) as $b
      | if $b == "" then {decision: "approved", reason: "^copilot-clean \\(review \($l.id), "}
        else {decision: "skip", reason: "^latest Copilot review \($b)"} end
      end
    end;
