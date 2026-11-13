# Plan: a better Dispatchers table

Status: designed and approved 2026-11-13 (Design System group "Dispatchers table"); built on feature/dispatchers-table.

## How it works today
- The page (apps/web/src/app/(workspace)/dispatch/dispatchers/page.tsx) asks GET dispatch/members for everyone. DispatchService.members returns up to 1000 rows, ordered by first name, and anything past 1000 is dropped without warning.
- The page then filters and searches in memory. There is no pagination or sorting, and the footer says "X of Y people".
- **Filters:** only the status tabs (Onboarding, Active, On leave, Leaving, Left, Paperwork, Missing details, All) and one search box.
- **Search** covers name, MC, team and job title only. It can't find someone by company or personal email, phone, RingCentral number or extension, or Telegram.
- **Missing filters:** MC, team, team lead, position (dispatcher, support, updater), job title, onboarded vs added by hand, and has drivers.
- **Missing columns:** team lead and the number of drivers.
- **Tab counts** follow the search but would ignore any other filter.
- **Pages already doing this server-side:** the review queue (features/onboarding/applications.tsx) and IT tasks search, sort and paginate on the server, and components/ui/pagination.tsx and FilterBar's sortOptions exist.

## Proposal
### API: GET dispatch/members filters on the server
- **New optional query fields,** validated in a DTO:

  | Field | Values |
  |---|---|
  | status | as today |
  | search | text, up to 100 characters |
  | mcId, teamId, leadId, jobTitleId | ids; leadId is a team lead's member id |
  | position | DISPATCHER, SUPPORT or UPDATER |
  | source | ONBOARDED or ADDED |
  | drivers | WITH or WITHOUT |
  | sort | name, mc, team, lead, drivers, since or status |
  | direction | asc or desc |
  | page, pageSize | pageSize 20, 50 or 100 |

- **Search** matches name, MC, team, job title, company and personal email, phone (digits, with or without the leading US 1), RingCentral number and extension, and Telegram. Once the existing-records plan lands it also matches other names and other company accounts. Every dispatch manager and administrator already reads these on the dispatcher page, so searching them exposes nothing new.
- **Team lead** means the lead's teams: their dispatchers, the lead themselves, and the supports and updaters who assist those dispatchers or the whole team.
- **MC and team for supports** come from whoever they assist, as everywhere else.
- **The response** adds total, counts per tab (honouring every filter except the tab itself), and options for the pickers. The options are the MCs, teams (with their MC), team leads and job titles that anyone in the list has, archived ones included and marked, so a filter can find people who left.
- **Older web compatibility:** a request with no new fields answers exactly as today, so an older web keeps working. Deploy the API first.
- **Speed:** the query moves to one filtered SQL with count(*) OVER (). Index member_assignments ("memberId", "endedAt") if the plan needs it, checked with EXPLAIN on a seeded *_test database.

### Web
- **Filter row** under the tabs: MC, Team (narrowed to the chosen MC), Team lead, Position, Job title. "More filters" holds Source and Drivers.
- **Active filters** show as chips with a Clear all. Every filter lives in the URL, so a view can be bookmarked or shared.
- **Columns:** see Decisions. Leaving, On leave and Missing details keep their own columns. Click a heading to sort.
- **Pagination** uses the existing Pagination component at the bottom: 20 per page by default, with 50 or 100 to choose.
- **Phones:** the filters sit behind a Filters button that opens a sheet, with the chips shown above the list.
- **Empty result:** "Nothing matches these filters" with Clear filters.
- **Paperwork** stays its own tab and table.

### Export
- An Export button in the page header exports the current view (tab, filters, search and sort, every page, up to 2000 rows) as a CSV file.
- **Who:** dispatch managers and administrators, the same people who see the page. Added on the user's request 2026-11-12: managers do this, not administrators.
- **Route:** GET dispatch/members/export with the same query fields. It is rate-limited (10 per 15 minutes per user), sent no-store, and named dispatchers-YYYY-MM-DD.csv.
- **Columns:** name, position, MC, team, team lead, job title, since, status, last day, company email, RingCentral number, extension and Telegram. Work details only: no personal email or phone, legal names, sign-ins or reasons, so the file doesn't spread personal data. Personal details stay on the person's page.
- **Cell safety:** cells starting with = + - @ are escaped (the rule existing-csv.ts already uses), so a spreadsheet never runs them.
- **Record:** each export writes a MEMBERS_EXPORTED dispatch event with the row count and the filter field names used, never the rows.

### Later, only if asked
- Saved views, such as "My team leads' teams".
- The same filters on Dispatch › Drivers and the team lead's /team page.
- A start date range filter.

## Decisions
User 2026-11-12: managers export; pages of 20, 50 or 100. The user left the rest to my recommendation:

- **Filters:** MC, Team, Team lead, Position, Job title. "More filters" holds Source (onboarded or added by hand) and Drivers (with or without). The Missing details tab already covers "no company email" and similar.
- **Page size:** 20 by default, which fits a laptop screen; 50 or 100 to choose. The choice stays in the URL.
- **Default sort:** by name. Clicking a heading sorts by MC, team, team lead, drivers, since or status.
- **Columns by screen width:**
  - Phone: Name (with position and team under it) and Status.
  - From 768px: add MC and Team.
  - From 1024px: add Team lead and Drivers.
  - From 1280px: add Job title and Since.

  Team lead and Drivers come before Job title because managers asked to work by team and lead.
- **Drivers** is the count of open driver assignments, and "—" for supports and updaters.

## Design screens
DispatchersFiltersScreen (desktop, filters and chips), DispatchersFiltersPhoneScreen (Filters sheet), DispatchersTeamLeadScreen (filtered by a lead, supports included), DispatchersEmptyFilterScreen, DispatchersExportScreen (export confirmation with the row count and columns).

## Build notes
- Update AGENTS.md ("Teams and dispatch members") with the new query, the export and its event.
- Test that every filter combines with the tabs, that a team lead filter includes whole-team supports, that pages and counts stay consistent, that export refuses past the limit and rate limit, and that cells are escaped.
