# Noorul Islam Madrasa Fee Management & Administration System

A comprehensive React + TypeScript web application for managing student academic fees, real-time collection counter, teacher class worksheets, examination results publishing, and administrative operations for Noorul Islam Higher Secondary Madrasa.

## Core Features

- **Public Institution Portal**:
  - Institutional overview, live enrolled student & faculty statistics
  - Faculty directory with direct Call and WhatsApp contact integration
  - Managing Committee member directory
  - Public notice board & announcement alerts
  - Photo gallery with full-screen lightbox preview
  - Direct student & parent login

- **Student Portal**:
  - Student profile card with admission number, class, and roll number
  - Multi-account switcher for sibling management on a single family device
  - Monthly fee breakdown (June - March cycle) with clear Paid / Pending status
  - Verified transaction history with printable official receipts
  - Published examination marksheet view with total marks, percentage, and grades
  - Class-specific announcements

- **Fee Collection & Cashier Portal**:
  - Live student search by name or admission number with auto-complete
  - Interactive monthly and custom fee item selector with instant calculation
  - Multi-mode payment support (Cash, UPI, Bank Transfer) with receipt generation
  - Full transaction ledger with receipt reprinting and filterable history
  - Student Master Ledger with outstanding dues and defaulters tracking
  - Financial analytics: daily, monthly, and academic year totals

- **Teacher Class Worksheet**:
  - Dynamic spreadsheet grid for class teachers
  - Dynamic custom columns (Attendance, Mid-term scores, Conduct/Remarks)
  - Inline score recording and sorting (by Name, Roll No, or Admission No)
  - Export worksheet directly to CSV
  - Print-ready clean layout

- **Examination Results Center**:
  - Subject-wise marks recording and evaluation for faculty
  - Automated calculation of totals, percentages, letter grades (A+, A, B+, etc.), and pass/fail status
  - Official publishing toggle
  - Public student result lookup by admission number and class

- **Administrative Console**:
  - Institutional profile and fee configuration (default fees, active academic year)
  - Student master enrollment management (add, edit, concessions, delete)
  - Faculty and staff RBAC management
  - Notice board management (create, target, delete announcements)

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide Icons, FontAwesome
- **Build Tool**: Vite
- **Database & Auth**: Firebase Firestore & Firebase Authentication
