# Student Discontinue & Re-admission Management System (വിദ്യാർത്ഥി ഡിസ്കണ്ടിന്യൂ & റീ-അഡ്മിഷൻ)

A comprehensive administrative subsystem for managing student departure (discontinuation) and subsequent re-admission across multiple academic years without data loss, preserving historical fee dues up to the departure date, and recording multi-year gap trajectories with auditable notes.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following product requirements and architectural decisions were confirmed based on user feedback and domain requirements:

- **Confirmed Decision 1 (Tab Placement)**: Dedicated sub-tab in the Admin sidebar under **Student Management**, titled **"Discontinue & Re-admission" (`ഡിസ്കണ്ടിന്യൂ & റീ-അഡ്മിഷൻ`)** with hashtag `#student-continuity`.
- **Confirmed Decision 2 (Multi-Year Gap & Trajectory Tracking)**: When a student leaves or returns (even after missing 2–3 academic years), the exact academic year of return is recorded alongside mandatory exit notes (കാരണം) and re-admission notes. The student timeline will explicitly display the discontinuation date, reason, gap duration, return date, and new class assignment.
- **Confirmed Decision 3 (Fee Continuity & Gap Ledger Discipline)**: Any unpaid fee dues prior to discontinuation remain preserved in the ledger up to the departure date. Crucially, **no fees are assessed or generated for the intervening gap years**. From the exact academic year and date of re-admission onwards, active fee generation resumes normally.
- **Confirmed Decision 4 (Two-Panel Dedicated View)**: The dedicated tab will feature an **Action & Filter Console** on top (to filter by class and execute discontinuation or re-admission) and a **Live Discontinued Student Directory** below (with search, duration tags, reason tooltips, and 1-click Re-admit dialog).

---

## 1. Overview & Core Concept

### What It Does
Provides madrasa administrators with a dedicated workspace to manage student continuity:
1. **Class-Filtered Discontinuation**: Admins select a class, choose a student, enter the departure date and reason (e.g., family relocation, transfer, medical, Madrasa change), and safely transition them to `Discontinued` status.
2. **Dedicated Discontinued Student Archive**: A dedicated, searchable registry displaying all discontinued students with their admission number, name, original class, exit date, exit reason, and inactive duration (e.g., "1 Year 4 Months / 2 Academic Years").
3. **Multi-Year Re-admission Modal**: When a student returns after 1, 2, or 3+ academic years, clicking **"Re-admit Student" (`റീ-അഡ്മിഷൻ`)** opens an guided wizard. Admins select the target Academic Year, assign the new Class and Division, enter the return date and reason/notes, and preview the historical gap and preserved prior fee balance.
4. **Historical Trajectory Integrity**: Discontinuations and re-admissions are written to the student's `continuityLog` array, `academicYears` map, and Firestore audit logs, preventing any overwriting of past records.
5. **Fee Ledger Insulation**: Fee collection and bulk demand generators will recognize the `Discontinued` state and bypass fee generation for gap periods while displaying pre-discontinuation balances when applicable.

### Target Audience
Madrasa Principals, Headmasters (Sadrs), Office Administrators, and Super Admins managing student cohorts across Kerala madrasa academic calendars (May/June to March/April).

### Key Value
Eliminates confusing manual deactivations or deletion of student records, maintains unbroken academic audit trails across years, and ensures returning students resume their studies with accurate fees and class levels.

---

## 2. User Experience & Visual Design

### Key User Flows

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DISCONTINUE & RE-ADMISSION WORKFLOW                    │
└─────────────────────────────────────────────────────────────────────────────┘

  [1. STUDENT LEAVES]
  Admin Navigation ──> #student-continuity
       │
       ▼
  Top Action Bar:
  ├── Select Class (e.g. "Class 4 B")
  ├── Select Student from dropdown or live search
  ├── Enter Exit Date & Reason (കാരണം / Notes)
  └── Click "Discontinue Student" (സുരക്ഷിതമായി ഡിസ്കണ്ടിന്യൂ ചെയ്യുക)
       │
       ▼
  [Confirmation Modal] ──> Commit to Firestore:
       • status: 'Discontinued'
       • continuityLog appended
       • academicYears[currentYear].status = 'Discontinued'
       • Audit log generated

  ─────────────────────────────────────────────────────────────────────────────

  [2. DISCONTINUED DIRECTORY]
  Real-time List Table:
  ├── Photo, Adm No, Name, Gender
  ├── Class at Departure & Academic Year
  ├── Exit Date & Recorded Reason (Note pill/tooltip)
  ├── Inactive Gap Duration (e.g., "2 Years 1 Month")
  ├── Outstanding Fees prior to exit (₹ Preserved)
  └── [Re-admit Student] Button & [View Trajectory] Button

  ─────────────────────────────────────────────────────────────────────────────

  [3. STUDENT RETURNS (RE-ADMISSION)]
  Click "Re-admit Student" ──> Guided Modal:
  ├── Current Info: Name, Adm No, Last Studied Class
  ├── Target Academic Year: Dropdown of active/future years
  ├── Target New Class: Dropdown with suggested next class
  ├── Return Date & Re-admission Notes (റീ-അഡ്മിഷൻ കാരണം)
  ├── Gap Summary: "2 missed academic years: 2024-2025, 2025-2026"
  ├── Fee Status Preview: "Preserved prior dues: ₹400. No gap fees charged."
  └── Commit Re-admission ──> Student status becomes 'Active', joins new class!
```

### Visual Identity & Theme
- **Layout & Structure**: Follows the Universal Frontend Design Constitution (SaaS Dashboard domain). Full 1440px desktop width, single-elevation cards with clean hairline borders (`border border-slate-200 dark:border-slate-800`), and generous whitespace.
- **Color Palette & Discipline (60-30-10)**:
  - `60% Neutral Canvas`: Crisp slate background (`bg-slate-50 / bg-white`).
  - `30% Structural Surfaces`: Clean white cards with `border-slate-200` and subtle slate headers.
  - `10% Accent Palette`:
    - Discontinue action: Warm rose/crimson accents (`bg-rose-600 hover:bg-rose-700`, text badges `bg-rose-50 text-rose-700 border-rose-200`).
    - Re-admission action: Emerald/teal accents (`bg-emerald-600 hover:bg-emerald-700`, text badges `bg-emerald-50 text-emerald-700 border-emerald-200`).
    - Gap metadata: Unboxed muted typography with bullet separators (`·`).
- **Typography & Tabular Discipline**:
  - Headings: `Plus Jakarta Sans` font.
  - Metrics, Adm Numbers, Dates, and Fees: `font-mono tabular-nums` for alignment without jitter.
  - Bilingual Malaylam + English labels to ensure intuitive day-to-day operation for Madrasa staff.
- **Zero-Pill Discipline**:
  - Tags and metadata (dates, missed years) rendered as unboxed quiet text separated by `·`.
  - Filter controls rendered as functional segmented button tabs.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Single Student Document with `continuityLog` and `academicYears` Map
- **Chosen Approach**: Retain the student's unique ID (`admissionNo` / doc ID). Add an array `continuityLog` storing each status transition, and update `academicYears[yearLabel]` with the exact class and status for that specific year.
- **Why**: Keeps student fees, receipts, attendance, and exam marks connected to one master identity. When generating multi-year reports or certificates, the full history is readily available without creating duplicated or orphaned student records.
- **Alternative Considered**: Creating a new student document upon re-admission was rejected because it fragments student ID, breaks fee continuity, and loses past attendance history.

### Decision 2: Fee Preservation & Gap Immunity
- **Chosen Approach**: When a student is discontinued:
  1. All payments made and pending fee items generated up to their discontinuation date remain intact.
  2. The fee engine filters out `Discontinued` students when generating monthly or annual fee dues.
  3. Upon re-admission, active fee generation starts from the re-admission date / target academic year.
- **Why**: Strictly adheres to the user's explicit rule: *"എന്നാണോ പോയത്? അതുവരെയുള്ള ഫീസുകൾ ഉണ്ടെങ്കിൽ അത് കാണിക്കണം പിന്നീട് എന്നാണോ വരുന്നത് അന്ന് മുതൽ ഉള്ളതാണ് ഉണ്ടാവുക. ഡിസ്ക കണ്ടിന്യൂ ചെയ്തതു മുതൽ കണ്ടിന്യൂ ചെയ്യുന്നതുവരെ ഉള്ളത് ഉണ്ടാവുകയില്ല."*

### Decision 3: Mandatory Exit & Re-entry Reasons
- **Chosen Approach**: Both discontinuation and re-admission forms require an administrative note / reason field.
- **Why**: In Madrasa management, students frequently move to relatives' houses, attend other institutions for higher school, or return years later. Preserving explicit notes explains gaps on official transfer certificates and parent inquiries.

---

## 4. Technical Architecture & Data Strategy

### System Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ADMIN PORTAL COMPONENT MAP                           │
└─────────────────────────────────────────────────────────────────────────────┘

  admin.html
  ├── Sidebar Navigation: <a href="#student-continuity">
  │
  ├── Section: #student-continuity-page
  │   ├── Header & Contextual Academic Year Indicator
  │   │
  │   ├── Panel A: "Discontinue Student" (വിദ്യാർത്ഥിയെ ഡിസ്കണ്ടിന്യൂ ചെയ്യുക)
  │   │   ├── Class Selector (#continuity-class-select)
  │   │   ├── Student Selector (#continuity-student-select)
  │   │   ├── Departure Date (#continuity-exit-date)
  │   │   ├── Departure Reason / Notes (#continuity-exit-reason)
  │   │   └── Action: #execute-discontinue-btn
  │   │
  │   └── Panel B: "Discontinued Students Archive" (ഡിസ്കണ്ടിന്യൂ ചെയ്തവർ)
  │       ├── Metrics Counter (Total Discontinued, Current Year Departures)
  │       ├── Search Input & Class Filter (#continuity-search-input)
  │       ├── Responsive Table (#discontinued-students-table-body)
  │       └── Action Buttons:
  │           ├── Re-admit (#btn-open-readmit)
  │           └── View History & Notes (#btn-view-continuity-history)
  │
  └── Modals:
      ├── #readmission-popup: Target Year, Target Class, Date, Notes, Gap Review
      └── #continuity-history-popup: Multi-year visual timeline of departures/returns

  ─────────────────────────────────────────────────────────────────────────────

  scripts/pages/admin-page.js
  ├── State: rawStudents, students, academicYears, feeItems, allPayments
  ├── Router: '#student-continuity' page activation
  ├── Handlers:
  │   ├── renderContinuityPage()
  │   ├── populateContinuityStudentDropdown()
  │   ├── handleDiscontinueStudent()
  │   ├── openReadmitModal()
  │   ├── handleExecuteReadmission()
  │   └── openContinuityHistoryModal()
  └── Firestore Mutations:
      └── updateDoc(studentRef, { status, continuityLog, academicYears, ... })
```

### Data Schema Extensions (`firebase-blueprint.json` & Firestore)

1. **Student Entity Updates**:
   - `status`: String enum now includes `'Active' | 'Inactive' | 'Graduated' | 'Discontinued'`.
   - `discontinuationDetails`:
     ```typescript
     {
       date: string;          // ISO date
       academicYear: string;  // e.g. "2024-2025"
       lastClass: string;     // e.g. "Class 4"
       reason: string;        // Notes on why student left
       recordedBy: string;    // Admin user email
     }
     ```
   - `readmissionDetails`:
     ```typescript
     {
       date: string;          // ISO date
       targetYear: string;    // e.g. "2026-2027"
       targetClass: string;   // e.g. "Class 6"
       reason: string;        // Notes on return
       gapYears: string[];    // e.g. ["2024-2025", "2025-2026"]
       recordedBy: string;
     }
     ```
   - `continuityLog`: Array of historical events:
     ```typescript
     Array<{
       id: string;
       type: 'discontinue' | 'readmit';
       timestamp: string;
       academicYear: string;
       class: string;
       reason: string;
       adminEmail: string;
       priorBalance?: number;
     }>
     ```

2. **Fee Generation & Collection Scoping**:
   - `collection-page.js` & `admin-page.js` fee calculations will treat `Discontinued` students as non-accruing for any fee cycles occurring after their discontinuation timestamp and before their re-admission timestamp.
   - Any payments made against prior balances will continue to be recorded against the student's unique ID.

---

## 5. Implementation Steps (To Be Executed After Approval)

1. **Update `firebase-blueprint.json` & Rules**:
   - Add `Discontinued` to allowed statuses and specify `continuityLog`, `discontinuationDetails`, and `readmissionDetails` schemas.
   - Run verification and deploy rules via `DeployRules` RPC if necessary.
2. **Add Navigation & UI Markup in `admin.html`**:
   - Insert the sidebar navigation link `#student-continuity`.
   - Build `#student-continuity-page` with the Discontinue Action form and Discontinued Directory table.
   - Add `#readmission-popup` and `#continuity-history-popup`.
3. **Implement Logic in `scripts/pages/admin-page.js`**:
   - Add `student-continuity` to `PAGE_PERMISSIONS` (`students.manage`).
   - Implement event listeners, dropdown synchronization, table rendering, and gap duration calculations.
   - Implement `handleDiscontinueStudent` and `handleExecuteReadmission` with Firestore batch/update operations and audit logging.
4. **Integrate Fee Continuity**:
   - Ensure fee summaries in `collection-page.js` and `admin-page.js` properly exclude discontinued students from active periodic demand generation while preserving past ledger dues.
5. **Compile & Verify**:
   - Run `compile_applet` and test all edge cases (immediate re-admission, multi-year gap re-admission, notes rendering, and fee ledger display).
