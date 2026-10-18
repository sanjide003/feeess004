import { signOut, onAuthStateChanged, signInAnonymously, EmailAuthProvider, reauthenticateWithCredential, updateEmail, updatePassword } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, writeBatch, getDocs, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, auth } from '../../config/firebase-config.js';
import { ADMIN_AUTH_DOC_ID, SINGLE_ADMIN_MODE, STAFF_ACCESS_COLLECTION } from '../../config/app-config.js';
import { BASE_PATH, applyCachedInstitutionLogo, enableSmartSelectWindowing, escapeHtml, formatDateDisplay, hardenExternalLinks, registerServiceWorker, rememberInstitutionLogo, renderVersionInfo, resolveSafePhotoUrl, sanitizeUrl } from '../shared/app-common.js';
import { showToast } from '../shared/toaster.js';

registerServiceWorker();
hardenExternalLinks();
enableSmartSelectWindowing(document, { visibleCount: 6 });
applyCachedInstitutionLogo(['admin-header-logo', 'admin-loader-logo']);

let isStaffAdminSession = false;
let staffAdminRecord = null;

const confirmPublicExit = (message = 'Navigating to the public page will log out this session. Do you want to continue?') => confirm(message);
window.logoutAdmin = (options = {}) => {
    const { skipConfirm = false } = options;
    if(!skipConfirm && !confirmPublicExit()) return;
    signOut(auth).then(async () => {
        await window.AppSession?.clearAll({ purgeClientData: true });
        window.location.href = 'index.html';
    });
};

const STUDENT_STATUS_OPTIONS = ['Active', 'Inactive', 'Alumni', 'Discontinued'];
const ADMIN_ROLE_OPTIONS = {
    super_admin: {
        label: 'Super Admin',
        badgeClass: 'bg-red-100 text-red-700 border-red-200',
        permissions: ['dashboard.view', 'academic-years.manage', 'staff.manage', 'students.manage', 'classes.manage', 'groups.manage', 'results.manage', 'concessions.manage', 'fees.manage', 'website.manage', 'security.manage', 'backup.export', 'backup.restore', 'audit.view']
    },
    operations_admin: {
        label: 'Operations Admin',
        badgeClass: 'bg-blue-100 text-blue-700 border-blue-200',
        permissions: ['dashboard.view', 'academic-years.manage', 'students.manage', 'classes.manage', 'groups.manage', 'results.manage', 'website.manage', 'audit.view']
    },
    finance_admin: {
        label: 'Finance Admin',
        badgeClass: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        permissions: ['dashboard.view', 'concessions.manage', 'fees.manage', 'backup.export', 'audit.view']
    },
    viewer: {
        label: 'Viewer',
        badgeClass: 'bg-gray-100 text-gray-700 border-gray-200',
        permissions: ['dashboard.view', 'audit.view']
    },
    result_operator: {
        label: 'Result Operator',
        badgeClass: 'bg-indigo-100 text-indigo-700 border-indigo-200',
        permissions: ['dashboard.view', 'results.manage', 'audit.view']
    }
};
const PAGE_PERMISSIONS = {
    dashboard: 'dashboard.view',
    'fee-manager': 'fees.manage',
    'academic-years': 'academic-years.manage',
    'add-staff': 'staff.manage',
    'staff-management': 'staff.manage',
    'manage-staff': 'staff.manage',
    'add-students': 'students.manage',
    'manage-students': 'students.manage',
    'student-continuity': 'students.manage',
    'manage-classes': 'classes.manage',
    'manage-groups': 'groups.manage',
    results: 'results.manage',
    'fee-concessions': 'concessions.manage',
    'fee-settings': 'fees.manage',
    'web-basic-info': 'website.manage',
    'web-notices': 'website.manage',
    'web-gallery': 'website.manage',
    'web-directory': 'website.manage',
    'web-directory-entries': 'website.manage',
    'security-settings': 'security.manage'
};

let students = [], classes = [], studentGroups = [], feeItems = [], allStaff = [], allPayments = [];
let resultSchemas = [];
let rawStudents = [];
let webContent = { notices: [], gallery: [], directoryCategories: [] };
let publicDirectoryEntries = [];
let categoryAuthConfig = { categories: {} };
let pageAccessConfig = { categories: {}, overrides: {} };
let editingStudentId = null, editingClassName = null, editingStaffId = null;
let academicYears = [];
let activeAcademicYear = '';
let adminAccounts = [];
let currentAdminEmail = '';
let currentAdminRole = 'super_admin';
let auditLogs = [];
let pendingRestorePayload = null;
let sessionControl = {};
let sessionRegistry = { sessions: {} };
let sessionRegistryHeartbeat = null;
let hasRedirectedNonSuperAdmin = false;
let isResultOperatorSession = false;
const MONTH_SEQUENCE = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const normalizeEmail = (value = '') => value.toString().trim().toLowerCase();
const toAcademicYearDocId = (academicYear = '') => String(academicYear || '').trim().replace(/[^\w-]/g, '_');
const getEnrollmentRef = (academicYear = '', studentId = '') => doc(db, `${BASE_PATH}/academicYears/${toAcademicYearDocId(academicYear || currentAcademicYear)}/enrollments`, studentId);
const buildEnrollmentPayload = (studentId = '', studentRecord = {}) => ({
    studentId,
    academicYear: studentRecord.academicYear || currentAcademicYear,
    class: studentRecord.class || '',
    status: studentRecord.status || 'Active',
    adm: studentRecord.adm || '',
    uid: studentRecord.uid || '',
    concessionFee: studentRecord.concessionFee ?? null,
    updatedAt: new Date().toISOString()
});
const syncEnrollmentRecord = async (studentId = '', studentRecord = {}) => {
    if (!studentId) return;
    const academicYear = studentRecord.academicYear || currentAcademicYear;
    await setDoc(getEnrollmentRef(academicYear, studentId), buildEnrollmentPayload(studentId, { ...studentRecord, academicYear }), { merge: true });
};
const getAdminAuthRef = () => doc(db, `${BASE_PATH}/settings`, ADMIN_AUTH_DOC_ID);
const getConfigRef = () => doc(db, `${BASE_PATH}/settings`, 'config');
const getSessionRegistryRef = () => doc(db, `${BASE_PATH}/settings`, 'sessionRegistry');

const ensureFeeItemsForAcademicYears = async (yearsList = academicYears) => {
    try {
        const confRef = getConfigRef();
        const configSnap = await getDoc(confRef);
        const d = configSnap.exists() ? configSnap.data() : {};
        let existingItems = Array.isArray(d.feeItems) ? [...d.feeItems] : [];
        let isUpdated = false;

        const targetYears = Array.isArray(yearsList) && yearsList.length
            ? yearsList
            : (Array.isArray(academicYears) && academicYears.length ? academicYears : [getActiveAcademicYearRecord()].filter(Boolean));

        targetYears.forEach((yearRecord) => {
            if (!yearRecord || !yearRecord.label || yearRecord.status === 'archived') return;
            const yearLabel = yearRecord.label;
            const suffix = yearLabel.replace(/[^0-9]/g, '').substring(2);
            const months = getAcademicMonthSequence(yearRecord).map((monthIndex) => MONTH_LABELS[monthIndex]);

            months.forEach((m) => {
                const key = `${m.toLowerCase().substring(0, 3)}-${suffix}`;
                if (!existingItems.find((i) => i.key === key)) {
                    existingItems.push({
                        key: key,
                        name: `${m} (${yearLabel})`,
                        type: 'month',
                        isVisible: true,
                        academicYear: yearLabel
                    });
                    isUpdated = true;
                }
            });
        });

        if (isUpdated) {
            await setDoc(confRef, { feeItems: existingItems, appName: d.appName || 'Fee Tracker Pro', defaultFee: d.defaultFee || 200 }, { merge: true });
        }
    } catch (e) {
        console.warn('Failed to ensure academic year fee items:', e);
    }
};
const getLocalDeviceId = () => {
    const key = 'fee_admin_device_id';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const generated = `dev-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem(key, generated);
    return generated;
};
const getDeviceLabel = () => {
    const ua = navigator.userAgent || '';
    if (ua.includes('Android')) return 'Android Device';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS Device';
    if (ua.includes('Windows')) return 'Windows Device';
    if (ua.includes('Macintosh')) return 'Mac Device';
    if (ua.includes('Linux')) return 'Linux Device';
    return 'Unknown Device';
};
const getStaffAccessRef = (email = '') => doc(db, STAFF_ACCESS_COLLECTION, normalizeEmail(email));
const syncStaffAccessRecord = async (staffRecord = {}) => {
    const email = normalizeEmail(staffRecord.email || '');
    if (!email) return;
    await setDoc(getStaffAccessRef(email), {
        email,
        isActive: staffRecord.isActive !== false,
        canCollect: staffRecord.canCollect !== false,
        canAccessWorksheet: staffRecord.canAccessWorksheet !== false,
        canManageResults: staffRecord.canManageResults === true,
        canAccessAdmin: staffRecord.canAccessAdmin === true,
        actLikeSuperAdmin: staffRecord.actLikeSuperAdmin === true,
        name: staffRecord.name || '',
        role: staffRecord.role || '',
        type: staffRecord.type || '',
        updatedAt: new Date().toISOString()
    }, { merge: true });
};
const removeStaffAccessRecord = async (email = '') => {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    await deleteDoc(getStaffAccessRef(normalized));
};
const rebuildStaffAccessIndex = async (staffRecords = []) => {
    const accessSnap = await getDocs(collection(db, STAFF_ACCESS_COLLECTION));
    const activeEmails = new Set(staffRecords.map((staffRecord) => normalizeEmail(staffRecord.email)).filter(Boolean));
    const operations = [];
    accessSnap.forEach((docSnap) => {
        if (!activeEmails.has(docSnap.id)) operations.push((batch) => batch.delete(docSnap.ref));
    });
    staffRecords.forEach((staffRecord) => {
        const email = normalizeEmail(staffRecord.email);
        if (!email) return;
        operations.push((batch) => batch.set(getStaffAccessRef(email), {
            email,
            isActive: staffRecord.isActive !== false,
            canCollect: staffRecord.canCollect !== false,
            canAccessWorksheet: staffRecord.canAccessWorksheet !== false,
            canManageResults: staffRecord.canManageResults === true,
            canAccessAdmin: staffRecord.canAccessAdmin === true,
            actLikeSuperAdmin: staffRecord.actLikeSuperAdmin === true,
            name: staffRecord.name || '',
            role: staffRecord.role || '',
            type: staffRecord.type || '',
            updatedAt: new Date().toISOString()
        }, { merge: true }));
    });
    await runBatchedWrites(operations);
};
const formatDateTime = (value) => {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${formatDateDisplay(value)} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};
const getRoleMeta = (role = 'viewer') => ADMIN_ROLE_OPTIONS[role] || ADMIN_ROLE_OPTIONS.viewer;
const normalizeAdminAccounts = (accounts = [], legacyEmail = '') => {
    const seen = new Set();
    const normalized = [];
    accounts.forEach((account) => {
        const email = normalizeEmail(account?.email);
        if (!email || seen.has(email)) return;
        seen.add(email);
        normalized.push({
            name: (account?.name || '').toString().trim(),
            email,
            role: ADMIN_ROLE_OPTIONS[account?.role] ? account.role : 'viewer',
            isActive: account?.isActive !== false,
            createdAt: account?.createdAt || new Date().toISOString(),
            updatedAt: account?.updatedAt || new Date().toISOString()
        });
    });
    if (legacyEmail && !seen.has(legacyEmail)) {
        normalized.unshift({
            name: 'Master Admin',
            email: legacyEmail,
            role: 'super_admin',
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    return normalized;
};
const buildAdminIndex = (accounts = []) => {
    return accounts.reduce((index, account) => {
        const rawEmail = (account?.email || '').toString().trim();
        const email = normalizeEmail(rawEmail);
        if (!email || account?.isActive === false) return index;
        index[email] = true;
        if (rawEmail && rawEmail !== email) index[rawEmail] = true;
        return index;
    }, {});
};
const buildAdminAuthPayload = (legacyEmail = '', accounts = []) => {
    const normalizedLegacyEmail = normalizeEmail(legacyEmail);
    const normalizedAdmins = normalizeAdminAccounts(accounts, normalizedLegacyEmail);
    return {
        email: normalizedLegacyEmail,
        admins: normalizedAdmins,
        adminsIndex: buildAdminIndex(normalizedAdmins)
    };
};
const getCurrentAdminAccount = () => adminAccounts.find((account) => account.email === currentAdminEmail) || null;
const hasPermission = (permission = '') => {
    if (!permission) return true;
    const currentAccount = getCurrentAdminAccount();
    const effectiveRole = currentAccount?.role || currentAdminRole || 'viewer';
    const roleMeta = getRoleMeta(effectiveRole);
    return Array.isArray(roleMeta?.permissions) && roleMeta.permissions.includes(permission);
};
const requirePermission = (permission, message = 'You do not have access to perform this action.') => {
    if (hasPermission(permission)) return true;
    alert(message);
    return false;
};
const enforceResultOperatorModeUI = () => {
    if (!isResultOperatorSession) return;
    document.querySelectorAll('.nav-link').forEach((link) => {
        const href = link.getAttribute('href') || '';
        const keepVisible = href === '#results' || href === 'result.html' || href === 'collection.html';
        link.classList.toggle('hidden', !keepVisible);
    });
    document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
    document.getElementById('results-page')?.classList.remove('hidden');
};
const enforceResultOperatorResultTabs = () => {
    const onlyAllowedTabs = isResultOperatorSession
        ? new Set(['result-marks-tab', 'result-published-tab', 'result-draft-tab'])
        : new Set(RESULT_DRAWER_TABS.map((entry) => entry.tab));
    const tabButtons = Array.from(document.querySelectorAll('.result-tab-btn'));
    const tabPanels = Array.from(document.querySelectorAll('.result-tab-content'));
    if (!tabButtons.length || !tabPanels.length) return;

    if (!isResultOperatorSession) {
        tabButtons.forEach((button) => button.classList.remove('hidden'));
        tabPanels.forEach((panel) => panel.classList.remove('hidden'));
        return;
    }

    tabButtons.forEach((button) => {
        const tabId = button.dataset.tab || '';
        button.classList.toggle('hidden', !onlyAllowedTabs.has(tabId));
    });
    tabPanels.forEach((panel) => {
        if (!onlyAllowedTabs.has(panel.id)) panel.classList.add('hidden');
    });
    switchResultTab(isResultOperatorSession ? 'result-marks-tab' : 'result-dashboard-tab');
};
const getCurrentAcademicYear = () => {
    const today = new Date();
    const month = today.getMonth();
    const year = today.getFullYear();
    if (month < 5) return `${year - 1}-${year}`;
    return `${year}-${year + 1}`;
};
let currentAcademicYear = getCurrentAcademicYear();
const normalizeAcademicYearLabel = (startYear, endYear) => {
    const start = parseInt(startYear, 10);
    const end = parseInt(endYear, 10);
    if (Number.isNaN(start) || Number.isNaN(end) || end != start + 1) return '';
    return `${start}-${end}`;
};
const sanitizeAcademicYearLabel = (label = '') => {
    const parts = String(label).match(/\d{4}/g);
    if (!parts || parts.length < 2) return currentAcademicYear;
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end !== start + 1) return currentAcademicYear;
    return `${start}-${end}`;
};
const buildAcademicYearLabelFromStart = (startYear = 0) => `${startYear}-${startYear + 1}`;
const getAcademicYearPresetLabels = () => {
    const labels = [];
    for (let year = 2020; year <= 2050; year += 1) {
        labels.push(buildAcademicYearLabelFromStart(year));
    }
    return labels;
};
const normalizeGenderLabel = (value = '') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized.startsWith('m') || normalized.includes('boy') || normalized.includes('male')) return 'Male';
    if (normalized.startsWith('f') || normalized.includes('girl') || normalized.includes('female')) return 'Female';
    return '';
};
const normalizeStudentStatus = (status = 'Active') => {
    const normalizedStatus = status?.toString().trim().toLowerCase();
    if (normalizedStatus === 'graduated' || normalizedStatus === 'alumni') {
        return 'Alumni';
    }
    return STUDENT_STATUS_OPTIONS.find((option) => option.toLowerCase() === normalizedStatus) || 'Active';
};
const getStudentStatusBadgeClass = (status) => ({
    Active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    Inactive: 'bg-gray-100 text-gray-700 border-gray-200',
    Transferred: 'bg-amber-100 text-amber-700 border-amber-200',
    'TC Issued': 'bg-rose-100 text-rose-700 border-rose-200',
    Discontinued: 'bg-rose-100 text-rose-700 border-rose-200',
    Alumni: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    Graduated: 'bg-indigo-100 text-indigo-700 border-indigo-200'
}[normalizeStudentStatus(status)] || 'bg-gray-100 text-gray-700 border-gray-200');
const compareClassLabels = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const sortClassLabels = (classList) => [...classList].sort(compareClassLabels);
const getDefaultClassLadder = () => Array.from({ length: 12 }, (_, index) => String(index + 1));
const buildDivisionLabels = (baseClass = '', count = 3) => {
    const normalizedBase = String(baseClass || '').trim().toUpperCase();
    if (!normalizedBase) return [];
    const normalizedCount = Math.max(1, Math.min(10, Number(count) || 0));
    return Array.from({ length: normalizedCount }, (_, index) => `${normalizedBase} ${String.fromCharCode(65 + index)}`);
};
const getActiveAcademicYearLabel = () => activeAcademicYear || currentAcademicYear;
const getActiveAcademicYearRecord = () => academicYears.find((year) => year.label === getActiveAcademicYearLabel()) || null;
const getAcademicMonthSequence = (yearRecord = {}) => {
    const startMonth = Number.isInteger(Number(yearRecord?.startMonth)) ? Number(yearRecord.startMonth) : 5;
    const endMonth = Number.isInteger(Number(yearRecord?.endMonth)) ? Number(yearRecord.endMonth) : 4;
    const months = [];
    let cursor = startMonth;
    const safetyCap = 24;
    for (let count = 0; count < safetyCap; count += 1) {
        months.push(cursor);
        if (cursor === endMonth) break;
        cursor = (cursor + 1) % 12;
    }
    return months.length ? months : [5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4];
};
const populateAcademicMonthSelectors = () => {
    const startSelect = document.getElementById('academic-year-start-month');
    const endSelect = document.getElementById('academic-year-end-month');
    const editStartSelect = document.getElementById('academic-year-edit-start-month');
    const editEndSelect = document.getElementById('academic-year-edit-end-month');
    if (!startSelect || !endSelect) return;
    const options = MONTH_LABELS.map((label, index) => `<option value="${index}">${label}</option>`).join('');
    startSelect.innerHTML = options;
    endSelect.innerHTML = options;
    if (editStartSelect) editStartSelect.innerHTML = options;
    if (editEndSelect) editEndSelect.innerHTML = options;
    if (!startSelect.value) startSelect.value = '5';
    if (!endSelect.value) endSelect.value = '4';
};
const populateAcademicYearPresetSelector = () => {
    const input = document.getElementById('academic-year-input');
    if (!input) return;
    if (!input.value.trim()) {
        const sortedYears = academicYears
            .map((y) => String(y.label || '').match(/^(\d{4})-(\d{4})$/))
            .filter(Boolean)
            .map((m) => Number(m[2]))
            .sort((a, b) => b - a);
        const lastEndYear = sortedYears[0] || new Date().getFullYear();
        input.value = `${lastEndYear}-${lastEndYear + 1}`;
    }
};
const enforceSetupGate = () => {
    const activeYear = getActiveAcademicYearRecord();
    const classCount = Array.isArray(activeYear?.classes) ? activeYear.classes.length : 0;
    const isSetupReady = Boolean(activeYear?.label) && classCount > 0;
    document.querySelectorAll('.nav-link').forEach((link) => {
        const target = (link.getAttribute('href') || '').replace('#', '');
        const allowWhenBlocked = target === 'academic-years' || target === 'manage-classes' || target === 'dashboard';
        if (isSetupReady) {
            link.classList.remove('opacity-40', 'pointer-events-none');
            return;
        }
        if (!allowWhenBlocked) {
            link.classList.add('opacity-40', 'pointer-events-none');
        } else {
            link.classList.remove('opacity-40', 'pointer-events-none');
        }
    });
    const statusEl = document.getElementById('dashboard-setup-status');
    if (statusEl && !isSetupReady) statusEl.textContent = 'Complete Academic Year + Classes first';
    return isSetupReady;
};
const getStudentsForYear = (targetYearLabel) => {
    const target = targetYearLabel || getActiveAcademicYearLabel();
    const activeLabel = getActiveAcademicYearLabel();
    return (rawStudents || []).map((student) => {
        const yearEntry = student.academicYears?.[target];
        const studentMasterYear = student.academicYear || currentAcademicYear;
        const isCurrentYear = studentMasterYear === target;

        if (yearEntry && typeof yearEntry === 'object') {
            return {
                ...student,
                _historicalYear: target,
                _isHistoricalView: target !== activeLabel,
                class: yearEntry.class || student.class,
                studentClass: yearEntry.class || student.studentClass || student.class,
                status: yearEntry.status || student.status
            };
        } else if (isCurrentYear) {
            return {
                ...student,
                _historicalYear: target,
                _isHistoricalView: target !== activeLabel
            };
        } else if (!student.academicYear && (!student.academicYears || Object.keys(student.academicYears).length === 0) && target === activeAcademicYear) {
            return {
                ...student,
                _historicalYear: target,
                _isHistoricalView: target !== activeLabel
            };
        }
        return null;
    }).filter(Boolean);
};

const getStudentsForActiveYear = () => getStudentsForYear(getActiveAcademicYearLabel());

const getClassesForYear = (targetYearLabel) => {
    const target = targetYearLabel || getActiveAcademicYearLabel();
    const yearRecord = academicYears.find((year) => year.label === target);
    const structuredClasses = Array.isArray(yearRecord?.classes) ? yearRecord.classes : [];
    const studentClasses = getStudentsForYear(target).map((student) => student.class).filter(Boolean);
    const combined = sortClassLabels([...new Set([...structuredClasses, ...studentClasses])]);
    if (combined.length > 0) return combined;
    const fallbackActive = Array.isArray(classes) && classes.length ? classes : (typeof getDefaultClassLadder === 'function' ? getDefaultClassLadder() : []);
    return sortClassLabels([...new Set(fallbackActive)]);
};

const getClassesForActiveYear = () => getClassesForYear(getActiveAcademicYearLabel());

const suggestNextClass = (currentClassStr) => {
    if (!currentClassStr) return '';
    const trimmed = String(currentClassStr).trim();
    if (trimmed.toUpperCase() === 'ALUMNI' || trimmed.toUpperCase() === 'GRADUATED') return 'ALUMNI';
    const match = trimmed.match(/^(.*?)(\d+)(\s*[A-Za-z])?$/i);
    if (match) {
        const prefix = match[1] || '';
        const num = parseInt(match[2], 10);
        const division = match[3] || '';
        if (num >= 12) return 'ALUMNI';
        if (num === 10 && !prefix.toLowerCase().includes('plus')) return (prefix + '11' + division).trim();
        const nextNum = num + 1;
        return `${prefix}${nextNum}${division}`.trim();
    }
    return trimmed;
};
const setAcademicYearBadges = () => {
    const activeYear = getActiveAcademicYearLabel();
    const badgeText = `Academic Year: ${activeYear}`;
    const addBadge = document.getElementById('add-students-year-badge');
    const manageStudentsBadge = document.getElementById('manage-students-year-badge');
    const manageClassesBadge = document.getElementById('manage-classes-year-badge');
    if (addBadge) addBadge.textContent = badgeText;
    if (manageStudentsBadge) manageStudentsBadge.textContent = badgeText;
    if (manageClassesBadge) manageClassesBadge.textContent = badgeText;
};
const syncActiveAcademicYearClasses = async (classNames, { replace = false } = {}) => {
    const normalizedClasses = sortClassLabels([...new Set(classNames.map((name) => name?.toString().trim().toUpperCase()).filter(Boolean))]);
    const activeLabel = getActiveAcademicYearLabel();
    let didChange = false;
    academicYears = academicYears.map((year) => {
        if (year.label !== activeLabel) return year;
        const existingClasses = Array.isArray(year.classes) ? sortClassLabels(year.classes) : [];
        const nextClasses = replace ? normalizedClasses : sortClassLabels([...new Set([...existingClasses, ...normalizedClasses])]);
        if (JSON.stringify(existingClasses) !== JSON.stringify(nextClasses)) {
            didChange = true;
            return { ...year, classes: nextClasses };
        }
        return year;
    });
    if (!didChange) return false;
    classes = getClassesForActiveYear();
    await persistAcademicYears();
    return true;
};
const removeClassFromActiveAcademicYear = async (className) => {
    const normalizedClassName = className?.toString().trim().toUpperCase();
    if (!normalizedClassName) return false;
    const activeLabel = getActiveAcademicYearLabel();
    let didChange = false;
    academicYears = academicYears.map((year) => {
        if (year.label !== activeLabel) return year;
        const existingClasses = Array.isArray(year.classes) ? year.classes : [];
        const nextClasses = existingClasses.filter((name) => name !== normalizedClassName);
        if (nextClasses.length !== existingClasses.length) {
            didChange = true;
            return { ...year, classes: sortClassLabels(nextClasses) };
        }
        return year;
    });
    if (!didChange) return false;
    classes = getClassesForActiveYear();
    await persistAcademicYears();
    return true;
};
const summarizeBackupCounts = (payload = {}) => {
    const collections = payload.collections || {};
    return Object.entries(collections)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : 0}`)
        .join(' • ');
};
const validateBackupPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object') return { valid: false, reason: 'Backup payload is empty.' };
    const collections = payload.collections || {};
    const requiredCollections = ['students', 'staff', 'studentGroups', 'payments', 'auditLogs'];
    for (const key of requiredCollections) {
        if (!Array.isArray(collections[key])) {
            return { valid: false, reason: `Missing or invalid collection: ${key}.` };
        }
    }
    return { valid: true, reason: '' };
};
const buildBackupPayload = async () => {
    const [studentsSnap, staffSnap, groupsSnap, paymentsSnap, auditSnap, configSnap, contentSnap, adminAuthSnap, academicYearsSnap] = await Promise.all([
        getDocs(collection(db, `${BASE_PATH}/students`)),
        getDocs(collection(db, `${BASE_PATH}/staff`)),
        getDocs(collection(db, `${BASE_PATH}/studentGroups`)),
        getDocs(collection(db, `${BASE_PATH}/payments`)),
        getDocs(collection(db, `${BASE_PATH}/auditLogs`)),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'config')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'content')),
        getDoc(getAdminAuthRef()),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'academicYears')),
    ]);
    return {
        exportedAt: new Date().toISOString(),
        institution: BASE_PATH,
        releaseStage: 'Phase 3',
        collections: {
            students: studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
            staff: staffSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
            studentGroups: groupsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
            payments: paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
            auditLogs: auditSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        },
        settings: {
            config: configSnap.exists() ? configSnap.data() : {},
            content: contentSnap.exists() ? contentSnap.data() : {},
            adminAuth: adminAuthSnap.exists() ? adminAuthSnap.data() : {},
            academicYears: academicYearsSnap.exists() ? academicYearsSnap.data() : {}
        }
    };
};
const restoreCollectionFromPayload = async (collectionName, records = []) => {
    const existing = await getDocs(collection(db, `${BASE_PATH}/${collectionName}`));
    const operations = [];
    existing.forEach((record) => operations.push((batch) => batch.delete(record.ref)));
    records.forEach((record) => {
        const { id, ...data } = record || {};
        if (!id) return;
        operations.push((batch) => batch.set(doc(db, `${BASE_PATH}/${collectionName}`, id), data));
    });
    await runBatchedWrites(operations);
};
const restoreFromBackupPayload = async (payload) => {
    const collections = payload?.collections || {};
    const settings = payload?.settings || {};
    await Promise.all([
        restoreCollectionFromPayload('students', collections.students || []),
        restoreCollectionFromPayload('staff', collections.staff || []),
        restoreCollectionFromPayload('studentGroups', collections.studentGroups || []),
        restoreCollectionFromPayload('payments', collections.payments || []),
        restoreCollectionFromPayload('auditLogs', collections.auditLogs || [])
    ]);
    await Promise.all([
        setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), settings.config || {}, { merge: false }),
        setDoc(doc(db, `${BASE_PATH}/settings`, 'content'), settings.content || {}, { merge: false }),
        setDoc(
            getAdminAuthRef(),
            buildAdminAuthPayload(
                settings?.adminAuth?.email || normalizeEmail(currentAdminEmail),
                Array.isArray(settings?.adminAuth?.admins) ? settings.adminAuth.admins : []
            ),
            { merge: false }
        ),
        setDoc(doc(db, `${BASE_PATH}/settings`, 'academicYears'), settings.academicYears || {}, { merge: false })
    ]);
};
const logAuditEvent = async ({ category = 'system', action, entityType = '', entityId = '', message = '', metadata = {} }) => {
    try {
        await addDoc(collection(db, `${BASE_PATH}/auditLogs`), {
            category,
            action,
            entityType,
            entityId,
            message,
            metadata,
            academicYear: getActiveAcademicYearLabel(),
            adminEmail: currentAdminEmail || currentAdminRole,
            adminRole: currentAdminRole,
            createdAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Failed to write audit log.', error);
    }
};
const renderAdminRoleList = () => {
    const listEl = document.getElementById('admin-role-list');
    const summaryEl = document.getElementById('admin-role-summary');
    if (!listEl || !summaryEl) return;
    const activeCount = adminAccounts.filter((account) => account.isActive).length;
    summaryEl.textContent = 'Single Super Admin Mode';
    const addAdminBtn = document.getElementById('add-admin-role-btn');
    if (addAdminBtn) addAdminBtn.classList.add('hidden');
    const roleSelect = document.getElementById('admin-role-type');
    if (roleSelect) {
        roleSelect.value = 'super_admin';
        roleSelect.disabled = true;
    }
    const activeToggle = document.getElementById('admin-role-active');
    if (activeToggle) {
        activeToggle.checked = true;
        activeToggle.disabled = true;
    }
    listEl.innerHTML = adminAccounts.length ? adminAccounts.map((account) => {
        const meta = getRoleMeta(account.role);
        return `
            <div class="border border-gray-200 rounded-xl p-4 bg-gray-50/70">
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                        <div class="font-bold text-gray-900">${escapeHtml(account.name || account.email)}</div>
                        <div class="text-sm text-gray-500 break-all">${escapeHtml(account.email)}</div>
                        <div class="mt-2 inline-flex items-center gap-2 text-xs font-bold px-2.5 py-1 rounded-full border ${meta.badgeClass}">${meta.label}</div>
                        <div class="text-xs text-gray-400 mt-2">Updated: ${escapeHtml(formatDateTime(account.updatedAt))}</div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <span class="px-3 py-2 rounded-lg text-sm font-bold bg-blue-50 text-blue-700">Primary super admin</span>
                    </div>
                </div>
            </div>`;
    }).join('') : '<p class="text-sm text-gray-500 italic">No admin accounts configured yet.</p>';
};
const renderSessionMonitor = () => {
    const startedAt = window.AppSession?.getStartedAt?.();
    const lastActiveAt = window.AppSession?.getLastActiveAt?.();
    const policy = window.AppSession?.getRolePolicy?.('admin') || {
        maxAgeMs: window.AppSession?.SESSION_MAX_AGE_MS || 0,
        idleMs: window.AppSession?.SESSION_IDLE_MAX_AGE_MS || 0
    };
    const absoluteExpiry = startedAt ? new Date(startedAt + (policy.maxAgeMs || 0)).toISOString() : '';
    const idleExpiry = lastActiveAt ? new Date(lastActiveAt + (policy.idleMs || 0)).toISOString() : '';
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setText('session-monitor-started', formatDateTime(startedAt));
    setText('session-monitor-active', formatDateTime(lastActiveAt));
    setText('session-monitor-absolute', formatDateTime(absoluteExpiry));
    setText('session-monitor-idle', formatDateTime(idleExpiry));
    setText('security-current-admin-email', currentAdminEmail || '--');
    setText('security-current-admin-role', `Role: ${getRoleMeta(currentAdminRole).label}`);
    setText('session-control-last-event', sessionControl?.lastForcedLogoutAt ? `Forced on ${formatDateTime(sessionControl.lastForcedLogoutAt)} by ${sessionControl.forcedBy || 'system'}.` : 'No forced logout recorded yet.');
    setText('dashboard-session-status', window.AppSession?.isFresh?.() ? 'Monitoring' : 'Expired');
    const deviceListEl = document.getElementById('session-device-list');
    if (deviceListEl) {
        const sessions = Object.values(sessionRegistry?.sessions || {})
            .filter((entry) => normalizeEmail(entry?.adminEmail || '') === normalizeEmail(currentAdminEmail))
            .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
        deviceListEl.innerHTML = sessions.length ? sessions.map((entry) => {
            const isCurrent = entry.deviceId === getLocalDeviceId();
            return `
                <div class="bg-white border rounded-lg p-3">
                    <div class="flex items-center justify-between gap-2">
                        <div class="font-bold text-gray-900 text-sm">${escapeHtml(entry.deviceLabel || 'Device')}</div>
                        <span class="text-[10px] px-2 py-0.5 rounded-full border ${isCurrent ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}">${isCurrent ? 'Current device' : 'Active'}</span>
                    </div>
                    <div class="text-xs text-gray-500 mt-1">${escapeHtml(entry.platform || navigator.platform || 'unknown platform')}</div>
                    <div class="text-[11px] text-gray-500 mt-1">Last seen: ${escapeHtml(formatDateTime(entry.lastSeenAt))}</div>
                </div>`;
        }).join('') : '<div class="text-xs text-gray-500">No active admin device sessions found.</div>';
    }
    const buildAccessSessionCard = (entry = {}, theme = 'cyan') => {
        const blocked = entry.isBlocked === true;
        const statusClass = blocked
            ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-emerald-50 text-emerald-700 border-emerald-200';
        return `<div class="bg-white border rounded-lg p-3">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                    <div class="font-bold text-gray-900 text-sm truncate">${escapeHtml(entry.userName || entry.userKey || entry.adminEmail || 'User')}</div>
                    <div class="text-xs text-gray-500 mt-1">${escapeHtml(entry.deviceLabel || 'Device')} • ${escapeHtml(entry.platform || 'unknown')}</div>
                    <div class="text-[11px] text-gray-500 mt-1">Last seen: ${escapeHtml(formatDateTime(entry.lastSeenAt))}</div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] px-2 py-0.5 rounded-full border ${statusClass}">${blocked ? 'Blocked' : 'Active'}</span>
                    <button class="w-8 h-8 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-100 session-action-more-btn" data-device-id="${escapeHtml(entry.deviceId || '')}" data-theme="${theme}">
                        <i class="fas fa-ellipsis-v"></i>
                    </button>
                </div>
            </div>
            <div class="hidden mt-2 pt-2 border-t text-[11px] session-action-menu" data-device-id="${escapeHtml(entry.deviceId || '')}">
                <button class="px-2 py-1 rounded border bg-white hover:bg-gray-50 mr-1 session-action-btn" data-action="force-logout" data-device-id="${escapeHtml(entry.deviceId || '')}">Force Logout</button>
                <button class="px-2 py-1 rounded border bg-white hover:bg-gray-50 session-action-btn" data-action="${blocked ? 'unblock' : 'block'}" data-device-id="${escapeHtml(entry.deviceId || '')}">${blocked ? 'Unblock' : 'Block'}</button>
            </div>
        </div>`;
    };
    const sessions = Object.values(sessionRegistry?.sessions || {});
    const collectionSessionsEl = document.getElementById('collection-session-list');
    if (collectionSessionsEl) {
        const collectionSessions = sessions.filter((entry) => String(entry.role || '').toLowerCase() === 'collection');
        collectionSessionsEl.innerHTML = collectionSessions.length
            ? collectionSessions.map((entry) => buildAccessSessionCard(entry, 'cyan')).join('')
            : '<div class="text-xs text-gray-500">No active collection sessions found.</div>';
    }
    const studentSessionsEl = document.getElementById('student-session-list');
    if (studentSessionsEl) {
        const studentSessions = sessions.filter((entry) => String(entry.role || '').toLowerCase() === 'student');
        studentSessionsEl.innerHTML = studentSessions.length
            ? studentSessions.map((entry) => buildAccessSessionCard(entry, 'indigo')).join('')
            : '<div class="text-xs text-gray-500">No active student sessions found.</div>';
    }
};
const updateSessionRegistryEntry = async (deviceId = '', updates = {}) => {
    if (!deviceId) return;
    const currentEntry = (sessionRegistry?.sessions || {})[deviceId] || {};
    await setDoc(getSessionRegistryRef(), {
        sessions: {
            [deviceId]: {
                ...currentEntry,
                ...updates,
                updatedAt: new Date().toISOString(),
                updatedBy: currentAdminEmail || ''
            }
        }
    }, { merge: true });
};
const updateAdminSessionRegistry = async () => {
    if (!currentAdminEmail || currentAdminRole !== 'super_admin') return;
    const deviceId = getLocalDeviceId();
    const entry = {
        deviceId,
        adminEmail: currentAdminEmail,
        adminRole: currentAdminRole,
        deviceLabel: getDeviceLabel(),
        platform: navigator.platform || '',
        userAgent: navigator.userAgent || '',
        lastSeenAt: new Date().toISOString()
    };
    await setDoc(getSessionRegistryRef(), {
        sessions: { [deviceId]: entry },
        updatedAt: new Date().toISOString()
    }, { merge: true });
};
const startSessionRegistryHeartbeat = () => {
    if (sessionRegistryHeartbeat) clearInterval(sessionRegistryHeartbeat);
    updateAdminSessionRegistry().catch((error) => console.error('Failed to update session registry.', error));
    sessionRegistryHeartbeat = setInterval(() => {
        updateAdminSessionRegistry().catch((error) => console.error('Failed to update session registry.', error));
    }, 60000);
};
const renderAuditLogList = () => {
    const actionFilter = document.getElementById('audit-filter-action')?.value || 'all';
    const term = document.getElementById('audit-search-input')?.value?.trim().toLowerCase() || '';
    const listEl = document.getElementById('audit-log-list');
    const summaryEl = document.getElementById('audit-log-summary');
    if (!listEl || !summaryEl) return;

    const filtered = auditLogs.filter((entry) => {
        const haystack = `${entry.action || ''} ${entry.category || ''} ${entry.message || ''} ${entry.adminEmail || ''} ${entry.entityType || ''}`.toLowerCase();
        return (actionFilter === 'all' || entry.category === actionFilter) && (!term || haystack.includes(term));
    });

    summaryEl.textContent = `${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}`;
    const dashCount = document.getElementById('dashboard-audit-count');
    if (dashCount) dashCount.textContent = String(Math.min(auditLogs.length, 99));

    const resolveAuditTarget = (entry = {}) => {
        if (entry.category === 'backup') return 'security-settings';
        if (entry.category === 'security') return 'security-settings';
        if (entry.category === 'website') return (entry.action || '').includes('gallery') ? 'web-gallery' : 'web-notices';
        if (entry.category === 'class') return 'manage-classes';
        if (entry.category === 'group') return 'manage-groups';
        if (entry.category === 'student') return 'manage-students';
        if (entry.category === 'fee') return 'fee-settings';
        return '';
    };

    const humanizeAction = (action = '') => action
        ? action.replace(/\./g, ' • ').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
        : 'General Event';

    listEl.innerHTML = filtered.length ? filtered.slice(0, 100).map((entry) => {
        if (entry.isClearCheckpoint || entry.action === 'audit.cleared') {
            const summary = entry.summary || {};
            const categories = summary.categories || {};
            const catPills = Object.entries(categories)
                .filter(([_, count]) => count > 0)
                .map(([cat, count]) => `<span class="inline-flex items-center px-2 py-0.5 rounded bg-amber-100/90 text-amber-900 text-[11px] font-bold border border-amber-300">${escapeHtml(cat.toUpperCase())}: ${count}</span>`)
                .join(' ');
            return `
            <div class="bg-amber-50/70 border border-amber-300 rounded-xl p-3.5 shadow-2xs space-y-2">
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 border-b border-amber-200/80 pb-2">
                    <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-amber-600 text-white flex items-center justify-center text-xs shadow-2xs font-bold">
                            <i class="fas fa-broom"></i>
                        </span>
                        <div>
                            <div class="font-extrabold text-xs sm:text-sm text-amber-950">${escapeHtml(entry.message || 'Audit logs cleared by Super Admin')}</div>
                            <div class="text-[11px] text-amber-800 font-medium">${escapeHtml(entry.adminEmail || 'Admin')} • ${escapeHtml(formatDateTime(entry.createdAt))}</div>
                        </div>
                    </div>
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-amber-200 text-amber-900 border border-amber-300 self-start sm:self-auto">Purge Checkpoint</span>
                </div>
                ${summary.totalPurged !== undefined ? `
                <div class="bg-white/95 p-2 rounded-lg border border-amber-200/80 text-xs text-slate-700 space-y-1">
                    <div class="font-semibold text-slate-800 text-[11px] flex items-center justify-between">
                        <span>Purged Logs Summary:</span>
                        <span class="font-bold text-amber-900 bg-amber-100 px-1.5 py-0.5 rounded">${summary.totalPurged} previous events cleared</span>
                    </div>
                    ${catPills ? `<div class="flex flex-wrap gap-1 pt-1">${catPills}</div>` : ''}
                    ${summary.period?.from ? `<div class="text-[10px] text-slate-400">Period: ${escapeHtml(formatDateTime(summary.period.from))} to ${escapeHtml(formatDateTime(summary.period.to))}</div>` : ''}
                </div>
                ` : ''}
            </div>`;
        }

        const target = resolveAuditTarget(entry);
        return `
        <div class="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs hover:border-slate-300 transition space-y-1.5">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
                <div class="min-w-0">
                    <div class="font-bold text-xs sm:text-sm text-slate-900 leading-snug break-words">${escapeHtml(entry.message || entry.action || 'Audit event')}</div>
                    <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(entry.adminEmail || 'system')} • ${escapeHtml(getRoleMeta(entry.adminRole).label)} • ${escapeHtml(formatDateTime(entry.createdAt))}</div>
                </div>
                <span class="inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wider bg-slate-50 text-slate-700 shrink-0 self-start sm:self-auto">${escapeHtml(entry.category || 'system')}</span>
            </div>
            <div class="text-[11px] text-slate-600 font-medium">Action: ${escapeHtml(humanizeAction(entry.action || ''))}</div>
            ${(entry.entityType || entry.entityId) ? `<div class="text-[11px] text-slate-500">${escapeHtml(entry.entityType || 'entity')}${entry.entityId ? ` • ${escapeHtml(entry.entityId)}` : ''}</div>` : ''}
            ${target ? `<div class="pt-1"><button class="audit-open-target-btn text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1 rounded transition" data-target="${target}">Open Related Section</button></div>` : ''}
        </div>`;
    }).join('') : '<p class="text-xs text-slate-500 py-6 text-center italic">No audit entries match the current filters.</p>';
};
const applyRoleAccessUI = () => {
    document.querySelectorAll('.nav-link').forEach((link) => {
        const target = link.getAttribute('href')?.replace('#', '');
        const permission = PAGE_PERMISSIONS[target];
        const allowed = !permission || hasPermission(permission);
        link.classList.toggle('hidden', !allowed);
    });

    document.querySelectorAll('.admin-quick-action').forEach((button) => {
        const target = button.dataset.targetPage || '';
        const permission = PAGE_PERMISSIONS[target];
        const allowed = !permission || hasPermission(permission);
        button.classList.toggle('hidden', !allowed);
    });

    document.getElementById('dashboard-admin-count').textContent = String(adminAccounts.filter((account) => account.isActive).length);
};
const ensureActiveAdminPageAccess = () => {
    const activeLink = document.querySelector('.nav-link.active');
    const activeTarget = activeLink?.getAttribute('href')?.replace('#', '') || 'dashboard';
    const requiredPermission = PAGE_PERMISSIONS[activeTarget];
    if (requiredPermission && !hasPermission(requiredPermission)) {
        activateAdminPage('dashboard', { suppressDeniedAlert: true });
    }
};
const renderDashboard = () => {
    const activeYear = getActiveAcademicYearLabel();
    const activeStaffCount = allStaff.filter((staff) => staff.isActive).length;
    const femaleCount = students.filter((student) => normalizeGenderLabel(student?.gender) === 'Female').length;
    const maleCount = students.filter((student) => normalizeGenderLabel(student?.gender) === 'Male').length;
    const setupChecks = [classes.length > 0, students.length > 0, feeItems.length > 0, adminAccounts.filter((account) => account.isActive).length > 0].filter(Boolean).length;

    document.getElementById('dashboard-active-year').textContent = activeYear;
    document.getElementById('dashboard-active-year-status').textContent = `${academicYears.length || 1} academic year record(s) configured`;
    document.getElementById('dashboard-student-count').textContent = students.filter((student) => normalizeStudentStatus(student.status) === 'Active').length;
    document.getElementById('dashboard-class-count').textContent = classes.length;
    document.getElementById('dashboard-staff-count').textContent = activeStaffCount;
    document.getElementById('dashboard-fee-item-count').textContent = feeItems.length;
    document.getElementById('dashboard-group-count').textContent = studentGroups.length;
    document.getElementById('dashboard-female-count').textContent = femaleCount;
    document.getElementById('dashboard-male-count').textContent = maleCount;
    document.getElementById('dashboard-setup-status').textContent = setupChecks === 4 ? 'Stage 3 workflow ready' : 'Setup pending';
    document.getElementById('academic-year-active-badge').textContent = activeYear;
    document.getElementById('dashboard-admin-count').textContent = String(adminAccounts.filter((account) => account.isActive).length);
    document.getElementById('dashboard-audit-count').textContent = String(Math.min(auditLogs.length, 99));
    renderSessionMonitor();
};

const renderAcademicYears = () => {
    const listEl = document.getElementById('academic-years-list');
    if (academicYears.length === 0) {
        listEl.innerHTML = '<div class="text-center py-8 bg-gray-50 rounded-xl border border-dashed text-gray-500 font-medium">No academic years configured yet.</div>';
        return;
    }

    listEl.innerHTML = academicYears
        .sort((a, b) => (b.startYear || 0) - (a.startYear || 0))
        .map((year) => {
            const isCurrent = year.label === activeAcademicYear;
            const isArchived = !isCurrent && year.status === 'archived';
            const currentStatus = isCurrent ? 'current' : (isArchived ? 'archived' : 'active');

            const startMonthLabel = MONTH_LABELS[Number(year.startMonth ?? 5)] || MONTH_LABELS[5];
            const endMonthLabel = MONTH_LABELS[Number(year.endMonth ?? 4)] || MONTH_LABELS[4];

            // Counts for this academic year: Total Students, Total Classes, Total Staff
            const yearStudents = (rawStudents || []).filter((student) => {
                if (student.academicYear === year.label) return true;
                if (student.academicYears && typeof student.academicYears === 'object' && student.academicYears[year.label]) return true;
                if (!student.academicYear && (!student.academicYears || Object.keys(student.academicYears).length === 0)) {
                    return year.label === activeAcademicYear;
                }
                return false;
            });
            const totalStudentsCount = yearStudents.length;

            const yearClasses = (Array.isArray(year.classes) && year.classes.length)
                ? year.classes
                : (year.label === activeAcademicYear ? classes : []);
            const totalClassesCount = yearClasses.length;

            const totalStaffCount = (allStaff || []).length;

            let badgeHtml = '';
            if (isCurrent) {
                badgeHtml = '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 inline-flex items-center gap-1.5"><i class="fas fa-check-circle text-emerald-600"></i> Current Academic Year</span>';
            } else if (isArchived) {
                badgeHtml = '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200">Archive</span>';
            } else {
                badgeHtml = '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-200">Active</span>';
            }

            return `
                <div class="flex flex-col justify-between bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:border-gray-300 transition" data-card-year="${escapeHtml(year.label)}">
                    <!-- Top row: Heading (Year) and 3-dot menu button at top-right corner -->
                    <div class="flex items-center justify-between gap-2 border-b border-gray-100 pb-2.5">
                        <div class="flex items-center gap-2">
                            <i class="fas fa-calendar-alt text-blue-600"></i>
                            <span class="text-lg font-extrabold text-gray-900">${escapeHtml(year.label)}</span>
                        </div>
                        <div class="relative">
                            <button class="year-menu-toggle w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition" data-label="${escapeHtml(year.label)}" title="More actions" aria-label="More actions">
                                <i class="fas fa-ellipsis-v"></i>
                            </button>
                            <div class="year-menu hidden absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
                                <button class="year-edit-btn w-full text-left px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-blue-50 flex items-center gap-2" data-label="${escapeHtml(year.label)}"><i class="fas fa-edit text-blue-600"></i> Edit months</button>
                                <button class="year-delete-btn w-full text-left px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 flex items-center gap-2 border-t border-gray-100" data-label="${escapeHtml(year.label)}"><i class="fas fa-trash text-red-600"></i> Delete year</button>
                            </div>
                        </div>
                    </div>

                    <!-- Second row: Status badge on left, Status dropdown select & Save on right -->
                    <div class="flex items-center justify-between gap-2 mt-3 flex-wrap">
                        <div>
                            ${badgeHtml}
                        </div>
                        <div class="flex items-center gap-1.5">
                            <select class="year-status-select px-2.5 py-1.5 border border-gray-300 rounded-lg text-xs font-bold bg-white text-gray-800 focus:border-blue-500 outline-none transition" data-label="${escapeHtml(year.label)}" data-initial-status="${currentStatus}">
                                <option value="current" ${currentStatus === 'current' ? 'selected' : ''}>Current Academic Year</option>
                                <option value="active" ${currentStatus === 'active' ? 'selected' : ''}>Active</option>
                                <option value="archived" ${currentStatus === 'archived' ? 'selected' : ''}>Archive</option>
                            </select>
                            <button type="button" class="save-year-status-btn hidden px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition items-center gap-1" data-label="${escapeHtml(year.label)}">
                                <i class="fas fa-save"></i> <span>Save</span>
                            </button>
                        </div>
                    </div>

                    <!-- Month Span: only month to month under status -->
                    <div class="text-xs font-semibold text-gray-600 mt-2.5 bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                        <i class="fas fa-clock text-blue-500 text-xs"></i>
                        <span>Months: <strong class="text-gray-800">${startMonthLabel}</strong> → <strong class="text-gray-800">${endMonthLabel}</strong></span>
                    </div>

                    <!-- Academic Year Counters: Total Students, Total Classes, Total Staff -->
                    <div class="grid grid-cols-3 gap-2 pt-3 mt-3 border-t border-gray-100 text-center">
                        <div class="bg-blue-50/80 border border-blue-100 rounded-lg p-2">
                            <div class="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Students</div>
                            <div class="text-base font-extrabold text-blue-900 mt-0.5">${totalStudentsCount}</div>
                        </div>
                        <div class="bg-indigo-50/80 border border-indigo-100 rounded-lg p-2">
                            <div class="text-[10px] font-bold text-indigo-700 uppercase tracking-wider">Classes</div>
                            <div class="text-base font-extrabold text-indigo-900 mt-0.5">${totalClassesCount}</div>
                        </div>
                        <div class="bg-emerald-50/80 border border-emerald-100 rounded-lg p-2">
                            <div class="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Staff</div>
                            <div class="text-base font-extrabold text-emerald-900 mt-0.5">${totalStaffCount}</div>
                        </div>
                    </div>
                </div>`;
        }).join('');
};
const openAcademicYearEditPopup = (yearLabel = '') => {
    const targetYear = academicYears.find((year) => year.label === yearLabel);
    if (!targetYear) return;
    document.getElementById('academic-year-edit-target-label').value = yearLabel;
    document.getElementById('academic-year-edit-label').value = yearLabel;
    document.getElementById('academic-year-edit-start-month').value = String(targetYear.startMonth ?? 5);
    document.getElementById('academic-year-edit-end-month').value = String(targetYear.endMonth ?? 4);
    const isCurrent = yearLabel === activeAcademicYear;
    const isArchived = !isCurrent && targetYear.status === 'archived';
    document.getElementById('academic-year-edit-status').value = isCurrent ? 'current' : (isArchived ? 'archived' : 'active');
    document.getElementById('academic-year-edit-popup').classList.remove('hidden');
    document.getElementById('academic-year-edit-popup').classList.add('flex');
};
const closeAcademicYearEditPopup = () => {
    document.getElementById('academic-year-edit-popup').classList.add('hidden');
    document.getElementById('academic-year-edit-popup').classList.remove('flex');
};

const persistAcademicYears = async () => {
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'academicYears'), {
        currentYear: activeAcademicYear || currentAcademicYear,
        years: academicYears
    }, { merge: true });
};

const refreshAcademicYearScopedData = (forceActive = false) => {
    students = getStudentsForActiveYear();
    classes = getClassesForActiveYear();
    setAcademicYearBadges();
    populateManageAcademicYearDropdown(forceActive);
    populateClassDropdowns();
    if (typeof populateResultSelectors === 'function') populateResultSelectors();
    enforceSetupGate();
    renderDashboard();

    if(!document.getElementById('manage-classes-page').classList.contains('hidden')) renderClassList();
    if(!document.getElementById('manage-students-page').classList.contains('hidden')) renderStudentList();
    if(!document.getElementById('student-continuity-page')?.classList.contains('hidden')) renderContinuityPage();
    if(!document.getElementById('manage-groups-page').classList.contains('hidden')) renderStudentGroups();
    if(!document.getElementById('fee-concessions-page').classList.contains('hidden')) renderConcessionsList();
};

const runBatchedWrites = async (operations, chunkSize = 400) => {
    if (!operations.length) return;

    for (let index = 0; index < operations.length; index += chunkSize) {
        const batch = writeBatch(db);
        operations.slice(index, index + chunkSize).forEach((applyOperation) => applyOperation(batch));
        await batch.commit();
    }
};

const buildStudentCleanupOperations = async (studentIds, { deleteStudents = false } = {}) => {
    const uniqueStudentIds = [...new Set(studentIds.filter(Boolean))];
    if (uniqueStudentIds.length === 0) return [];

    const paymentSnaps = await Promise.all(
        uniqueStudentIds.map((studentId) => getDocs(query(collection(db, `${BASE_PATH}/payments`), where("studentId", "==", studentId))))
    );

    const operations = [];

    if (deleteStudents) {
        uniqueStudentIds.forEach((studentId) => {
            operations.push((batch) => batch.delete(doc(db, `${BASE_PATH}/students`, studentId)));
            const student = rawStudents.find((entry) => entry.id === studentId) || {};
            operations.push((batch) => batch.delete(getEnrollmentRef(student.academicYear || currentAcademicYear, studentId)));
        });
    }

    paymentSnaps.forEach((snap) => {
        snap.forEach((paymentDoc) => {
            operations.push((batch) => batch.delete(paymentDoc.ref));
        });
    });

    studentGroups
        .filter((group) => group.memberIds.some((memberId) => uniqueStudentIds.includes(memberId)))
        .forEach((group) => {
            const nextMemberIds = group.memberIds.filter((memberId) => !uniqueStudentIds.includes(memberId));
            if (nextMemberIds.length < 2) {
                operations.push((batch) => batch.delete(doc(db, `${BASE_PATH}/studentGroups`, group.id)));
                return;
            }
            operations.push((batch) => batch.update(doc(db, `${BASE_PATH}/studentGroups`, group.id), { memberIds: nextMemberIds }));
        });

    return operations;
};

const deleteStudentsAndDependencies = async (studentIds) => {
    const operations = await buildStudentCleanupOperations(studentIds, { deleteStudents: true });
    await runBatchedWrites(operations);
};

// Drawer
const drawer = document.getElementById('side-drawer');
const overlay = document.getElementById('drawer-overlay');
const drawerNav = drawer?.querySelector('nav');
const resultExitBtn = document.getElementById('result-exit-btn');
const publicLogoutBtn = document.getElementById('admin-public-btn');
const openedFromCollection = new URLSearchParams(window.location.search).get('from') === 'collection';
let currentResultTabId = 'result-dashboard-tab';
const RESULT_DRAWER_TABS = [
    { tab: 'result-dashboard-tab', label: 'Dashboard', icon: 'fa-chart-line' },
    { tab: 'result-settings-tab', label: 'Settings', icon: 'fa-sliders' },
    { tab: 'result-subjects-tab', label: 'Manage Subjects', icon: 'fa-book' },
    { tab: 'result-grades-tab', label: 'Grade Rules', icon: 'fa-list-check' },
    { tab: 'result-marks-tab', label: 'Marks Entry', icon: 'fa-pen' },
    { tab: 'result-published-tab', label: 'Published', icon: 'fa-check-circle' },
    { tab: 'result-draft-tab', label: 'Draft', icon: 'fa-file-lines' },
    { tab: 'result-block-tab', label: 'Block Classes', icon: 'fa-ban' },
    { tab: 'result-snapshot-tab', label: 'Snapshot Export', icon: 'fa-download' },
    { tab: 'result-promotion-tab', label: 'Class Promotion', icon: 'fa-arrow-up-right-dots' }
];
const syncDrawerForResultManagement = (targetId = '') => {
    if (!drawerNav) return;
    const isResultPage = targetId === 'results';
    drawerNav.querySelectorAll('.drawer-heading, .nav-link').forEach((el) => {
        el.classList.toggle('hidden', isResultPage);
    });
    drawerNav.querySelectorAll('.result-drawer-link').forEach((el) => el.remove());
    if (isResultPage) {
        const allowedTabs = isResultOperatorSession
            ? new Set(['result-marks-tab', 'result-published-tab', 'result-draft-tab'])
            : new Set(RESULT_DRAWER_TABS.map((entry) => entry.tab));
        RESULT_DRAWER_TABS.filter((entry) => allowedTabs.has(entry.tab)).forEach((entry) => {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'result-drawer-link w-full text-left drawer-link flex items-center gap-3 p-3 transition';
            link.dataset.resultTab = entry.tab;
            link.title = entry.label;
            link.innerHTML = `<i class="fas ${entry.icon} w-5 text-center shrink-0"></i><span class="text-sm nav-text">${entry.label}</span>`;
            link.addEventListener('click', () => {
                switchResultTab(entry.tab);
                if (!isDesktop()) toggleDrawer(false);
            });
            drawerNav.appendChild(link);
        });
    }
    if (resultExitBtn) {
        const labelEl = resultExitBtn.querySelector('span');
        if (labelEl) labelEl.textContent = isResultPage ? 'Exit Result Management' : 'Admin Logout';
        resultExitBtn.onclick = isResultPage ? () => {
            if (isResultOperatorSession && openedFromCollection) window.location.href = 'collection.html';
            else activateAdminPage('dashboard', { pushHistory: true });
        } : () => window.logoutAdmin();
    }
    if (publicLogoutBtn) {
        const txt = publicLogoutBtn.querySelector('span');
        if (txt) txt.textContent = 'Logout';
        publicLogoutBtn.onclick = () => window.logoutAdmin();
        if (isResultPage && isResultOperatorSession) {
            publicLogoutBtn.classList.remove('hidden');
            resultExitBtn?.classList.add('hidden');
        } else if (isResultPage) {
            publicLogoutBtn.classList.add('hidden');
            resultExitBtn?.classList.remove('hidden');
        } else {
            publicLogoutBtn.classList.remove('hidden');
            resultExitBtn?.classList.remove('hidden');
        }
    }
};
const updateResultDrawerActiveState = () => {
    drawerNav?.querySelectorAll('.result-drawer-link').forEach((link) => {
        const isActive = link.dataset.resultTab === currentResultTabId;
        link.classList.toggle('bg-indigo-600', isActive);
        link.classList.toggle('text-white', isActive);
        link.classList.toggle('border', !isActive);
    });
};

const isDesktop = () => window.innerWidth >= 1024;

const setSidebarCollapsed = (collapsed) => {
    const adminApp = document.getElementById('admin-app');
    if (!adminApp) return;
    adminApp.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('admin_sidebar_collapsed', collapsed ? 'true' : 'false');
    if (!isDesktop() && overlay) {
        if (!collapsed) {
            overlay.classList.remove('hidden');
            setTimeout(() => overlay.classList.remove('opacity-0'), 10);
        } else {
            overlay.classList.add('opacity-0');
            setTimeout(() => overlay.classList.add('hidden'), 300);
        }
    }
};

const toggleSidebarState = () => {
    const adminApp = document.getElementById('admin-app');
    const isCollapsed = adminApp?.classList.contains('sidebar-collapsed');
    setSidebarCollapsed(!isCollapsed);
};

const initSidebarState = () => {
    if (!isDesktop()) {
        setSidebarCollapsed(true);
    } else {
        const stored = localStorage.getItem('admin_sidebar_collapsed');
        setSidebarCollapsed(stored === 'true');
    }
};

const toggleDrawer = (open) => {
    setSidebarCollapsed(!open);
};

document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
    toggleSidebarState();
});
document.getElementById('admin-mobile-menu-btn')?.addEventListener('click', () => {
    setSidebarCollapsed(false);
});
overlay?.addEventListener('click', () => setSidebarCollapsed(true));

initSidebarState();
window.addEventListener('resize', () => {
    if (isDesktop()) {
        if (overlay && !overlay.classList.contains('hidden')) {
            overlay.classList.add('opacity-0');
            overlay.classList.add('hidden');
        }
    }
});

const activateAdminPage = (targetId, options = {}) => {
    const { suppressDeniedAlert = false, pushHistory = true } = options;
    if (targetId === 'web-directory' || targetId === 'web-directory-entries') targetId = 'add-staff';
    if (targetId === 'manage-staff') targetId = 'staff-management';
    const setupReady = enforceSetupGate();
    if (!setupReady && !['dashboard', 'academic-years', 'manage-classes'].includes(targetId)) {
        if (!suppressDeniedAlert) alert('Complete Academic Year and Class setup first.');
        targetId = 'academic-years';
    }
    const requiredPermission = PAGE_PERMISSIONS[targetId];
    if (requiredPermission && !hasPermission(requiredPermission)) {
        if (!suppressDeniedAlert) alert('Your admin role does not allow access to this page.');
        targetId = 'dashboard';
    }
    document.querySelectorAll('.nav-link').forEach((link) => {
        const href = link.getAttribute('href');
        link.classList.toggle('active', href === `#${targetId}`);
    });
    document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
    const targetPageEl = document.getElementById(`${targetId}-page`);
    if (targetPageEl) {
        targetPageEl.classList.remove('hidden');
    }

    if(targetId === 'dashboard') renderDashboard();
    if(targetId === 'academic-years') renderAcademicYears();
    if(targetId === 'manage-students') { populateManageAcademicYearDropdown(); populateClassDropdowns(); renderStudentList(); }
    if(targetId === 'promote-students') { window.location.href = 'result.html'; return; }
    if(targetId === 'student-continuity') renderContinuityPage();
    if(targetId === 'manage-classes') { populateClassDropdowns(); renderClassList(); }
    if(targetId === 'manage-groups') renderStudentGroups();
    if(targetId === 'results') renderResultManagement();
    if(targetId === 'add-staff') { renderDirectoryCategories(); }
    if(targetId === 'staff-management' || targetId === 'manage-staff') { renderStaffList(); }
    if(targetId === 'fee-settings') renderFeeItemsManagement();
    if(targetId === 'fee-concessions') { populateClassDropdowns(); renderConcessionsList(); }
    if(targetId === 'web-directory') { renderDirectoryCategories(); }
    if(targetId === 'web-directory-entries') { renderDirectoryEntryForm(); renderDirectoryEntries(); }
    if(targetId === 'security-settings') { renderAdminRoleList(); renderSessionMonitor(); renderAuditLogList(); }
    syncDrawerForResultManagement(targetId);

    if(pushHistory) {
        const nextHash = `#${targetId}`;
        if(window.location.hash !== nextHash) history.pushState({ adminTab: targetId }, '', nextHash);
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    if (!isDesktop()) toggleDrawer(false);
};

// Navigation
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        if(e.currentTarget.hasAttribute('target')) { window.open(e.currentTarget.href, '_blank'); return; }
        const targetId = e.currentTarget.getAttribute('href').substring(1);
        activateAdminPage(targetId, { pushHistory: true });
    });
});

document.querySelectorAll('.admin-quick-action').forEach((button) => {
    button.addEventListener('click', () => activateAdminPage(button.dataset.targetPage, { pushHistory: true }));
});

window.addEventListener('hashchange', () => {
    if (isResultOperatorSession) {
        enforceResultOperatorModeUI();
        renderResultManagement();
        syncDrawerForResultManagement('results');
        return;
    }
    const targetId = (window.location.hash || '#dashboard').replace('#', '') || 'dashboard';
    activateAdminPage(targetId, { pushHistory: false, suppressDeniedAlert: true });
});
window.addEventListener('popstate', () => {
    if (isResultOperatorSession) {
        enforceResultOperatorModeUI();
        renderResultManagement();
        syncDrawerForResultManagement('results');
        return;
    }
    const targetId = (window.location.hash || '#dashboard').replace('#', '') || 'dashboard';
    activateAdminPage(targetId, { pushHistory: false, suppressDeniedAlert: true });
});
document.getElementById('admin-public-btn')?.addEventListener('click', () => window.logoutAdmin());
if (window.location.hash === '#results') {
    activateAdminPage('results', { pushHistory: false, suppressDeniedAlert: true });
} else {
    activateAdminPage((window.location.hash || '#dashboard').replace('#', '') || 'dashboard', { pushHistory: false, suppressDeniedAlert: true });
}

// --- ADMIN PHOTO WIDGET HANDLING ---
let activeAdminCropImg = null;
let adminCropZoom = 1;
let adminCropPanX = 0;
let adminCropPanY = 0;
let adminCameraStream = null;
let activePhotoTargetInputId = '';
let activePhotoTargetPreviewId = '';
let activePhotoTargetPlaceholderId = '';
let activePhotoTargetRemoveBtnId = '';

const drawAdminCropCanvas = () => {
    const canvas = document.getElementById('admin-crop-canvas');
    if (!canvas || !activeAdminCropImg) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 150, 150);

    const drawWidth = 150 * adminCropZoom;
    const drawHeight = (activeAdminCropImg.height / activeAdminCropImg.width) * drawWidth;

    const xOffset = (150 - drawWidth) / 2 + (adminCropPanX * drawWidth / 100);
    const yOffset = (150 - drawHeight) / 2 + (adminCropPanY * drawHeight / 100);

    ctx.drawImage(activeAdminCropImg, xOffset, yOffset, drawWidth, drawHeight);
};

const setupAdminPhotoWidget = (inputId, previewId, placeholderId, removeBtnId, fileInputId, cameraBtnId, uploadBtnId) => {
    const fileInput = document.getElementById(fileInputId);
    const cameraBtn = document.getElementById(cameraBtnId);
    const uploadBtn = document.getElementById(uploadBtnId);
    const removeBtn = document.getElementById(removeBtnId);

    const showCropper = (imageSrc) => {
        const img = new Image();
        img.onload = () => {
            activeAdminCropImg = img;
            adminCropZoom = 1;
            adminCropPanX = 0;
            adminCropPanY = 0;
            activePhotoTargetInputId = inputId;
            activePhotoTargetPreviewId = previewId;
            activePhotoTargetPlaceholderId = placeholderId;
            activePhotoTargetRemoveBtnId = removeBtnId;

            document.getElementById('admin-crop-zoom').value = 1;
            document.getElementById('admin-crop-panx').value = 0;
            document.getElementById('admin-crop-pany').value = 0;
            document.getElementById('admin-zoom-label').textContent = '1.0x';
            document.getElementById('admin-crop-modal').classList.remove('hidden');
            document.getElementById('admin-crop-modal').classList.add('flex');
            drawAdminCropCanvas();
        };
        img.src = imageSrc;
    };

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = () => showCropper(reader.result);
                reader.readAsDataURL(file);
            }
        });
    }

    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => fileInput.click());
    }

    if (cameraBtn) {
        cameraBtn.addEventListener('click', async () => {
            const modal = document.getElementById('admin-camera-modal');
            activePhotoTargetInputId = inputId;
            activePhotoTargetPreviewId = previewId;
            activePhotoTargetPlaceholderId = placeholderId;
            activePhotoTargetRemoveBtnId = removeBtnId;
            const ok = await startAdminCameraStream('user');
            if (ok && modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        });
    }

    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            document.getElementById(inputId).value = '';
            const preview = document.getElementById(previewId);
            const placeholder = document.getElementById(placeholderId);
            if (preview) preview.classList.add('hidden');
            if (placeholder) placeholder.classList.remove('hidden');
            removeBtn.classList.add('hidden');
        });
    }
};

let adminCameraFacingMode = 'user';

const compressImageFileToBase64 = (file, maxKb = 50) => {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('No file provided'));
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                const maxDim = 1200;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                let quality = 0.85;
                let base64 = canvas.toDataURL('image/jpeg', quality);
                const targetBytes = maxKb * 1024;

                while (base64.length * 0.75 > targetBytes && quality > 0.20) {
                    quality -= 0.10;
                    base64 = canvas.toDataURL('image/jpeg', quality);
                }

                while (base64.length * 0.75 > targetBytes && width > 150) {
                    width = Math.round(width * 0.85);
                    height = Math.round(height * 0.85);
                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);
                    base64 = canvas.toDataURL('image/jpeg', quality);
                }

                resolve(base64);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
};

const startAdminCameraStream = async (facingMode = 'user') => {
    const video = document.getElementById('admin-camera-video');
    if (!video) return false;
    if (adminCameraStream) {
        adminCameraStream.getTracks().forEach(track => track.stop());
        adminCameraStream = null;
    }
    adminCameraFacingMode = facingMode;
    try {
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: facingMode },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });
        } catch (e1) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
            } catch (e2) {
                stream = await navigator.mediaDevices.getUserMedia({ video: true });
            }
        }
        adminCameraStream = stream;
        video.srcObject = adminCameraStream;
        await video.play();
        return true;
    } catch (err) {
        console.error('Camera access error:', err);
        alert('Unable to access camera. Please check camera permissions in browser.');
        return false;
    }
};

const stopAdminCamera = () => {
    if (adminCameraStream) {
        adminCameraStream.getTracks().forEach(track => track.stop());
        adminCameraStream = null;
    }
    const modal = document.getElementById('admin-camera-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

const updateAdminPhotoWidgetPreview = (value, previewId, placeholderId, removeBtnId, inputId) => {
    const preview = document.getElementById(previewId);
    const placeholder = document.getElementById(placeholderId);
    const removeBtn = document.getElementById(removeBtnId);
    const input = document.getElementById(inputId);

    if (input) input.value = value || '';
    if (value) {
        if (preview) { preview.src = value; preview.classList.remove('hidden'); }
        if (placeholder) placeholder.classList.add('hidden');
        if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
        if (preview) preview.classList.add('hidden');
        if (placeholder) placeholder.classList.remove('hidden');
        if (removeBtn) removeBtn.classList.add('hidden');
    }
};

const updateLogoWidgetPreview = (logoUrl) => {
    const preview = document.getElementById('web-logo-preview');
    const placeholder = document.getElementById('web-logo-placeholder');
    const removeBtn = document.getElementById('web-logo-remove-btn');
    const logoInput = document.getElementById('web-logo');
    if (logoInput) logoInput.value = logoUrl || '';
    if (logoUrl) {
        if (preview) { preview.src = logoUrl; preview.classList.remove('hidden'); }
        if (placeholder) placeholder.classList.add('hidden');
        if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
        if (preview) preview.classList.add('hidden');
        if (placeholder) placeholder.classList.remove('hidden');
        if (removeBtn) removeBtn.classList.add('hidden');
    }
};

const initBasicInfoLogoWidget = () => {
    const uploadBtn = document.getElementById('web-logo-upload-btn');
    const fileInput = document.getElementById('web-logo-file-input');
    const removeBtn = document.getElementById('web-logo-remove-btn');

    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
    }

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Compressing...';
                const base64 = await compressImageFileToBase64(file, 60);
                updateLogoWidgetPreview(base64);
            } catch (err) {
                console.error('Logo compression failed:', err);
                alert('Unable to process logo: ' + (err?.message || 'Error'));
            } finally {
                uploadBtn.disabled = false;
                uploadBtn.innerHTML = '<i class="fas fa-upload mr-1"></i> Upload Logo';
                fileInput.value = '';
            }
        });
    }

    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            updateLogoWidgetPreview('');
        });
    }
};

const initAllAdminPhotoWidgets = () => {
    setupAdminPhotoWidget('st-photo', 'st-photo-preview', 'st-photo-placeholder', 'st-remove-btn', 'st-file-input', 'st-camera-btn', 'st-upload-btn');
    setupAdminPhotoWidget('e-st-photo', 'e-st-photo-preview', 'e-st-photo-placeholder', 'e-st-remove-btn', 'e-st-file-input', 'e-st-camera-btn', 'e-st-upload-btn');
    setupAdminPhotoWidget('add-stu-photo', 'add-stu-photo-preview', 'add-stu-photo-placeholder', 'add-stu-remove-btn', 'add-stu-file-input', 'add-stu-camera-btn', 'add-stu-upload-btn');
    setupAdminPhotoWidget('e-stu-photo', 'e-stu-photo-preview', 'e-stu-photo-placeholder', 'e-stu-remove-btn', 'e-stu-file-input', 'e-stu-camera-btn', 'e-stu-upload-btn');
    initBasicInfoLogoWidget();
    initGalleryUploadControls();
    initNoticeUploadControls();

    const noticeDtInput = document.getElementById('new-notice-dt');
    if (noticeDtInput && !noticeDtInput.value) {
        noticeDtInput.value = new Date().toISOString().split('T')[0];
    }

    // Set up common modal event bindings once
    document.getElementById('admin-camera-close-btn')?.addEventListener('click', stopAdminCamera);
    document.getElementById('admin-camera-cancel-btn')?.addEventListener('click', stopAdminCamera);
    document.getElementById('admin-camera-flip-btn')?.addEventListener('click', async () => {
        const nextMode = adminCameraFacingMode === 'user' ? 'environment' : 'user';
        await startAdminCameraStream(nextMode);
    });
    document.getElementById('admin-camera-capture-btn')?.addEventListener('click', () => {
        const video = document.getElementById('admin-camera-video');
        if (!video) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        stopAdminCamera();

        const img = new Image();
        img.onload = () => {
            activeAdminCropImg = img;
            adminCropZoom = 1;
            adminCropPanX = 0;
            adminCropPanY = 0;
            document.getElementById('admin-crop-zoom').value = 1;
            document.getElementById('admin-crop-panx').value = 0;
            document.getElementById('admin-crop-pany').value = 0;
            document.getElementById('admin-zoom-label').textContent = '1.0x';
            document.getElementById('admin-crop-modal').classList.remove('hidden');
            document.getElementById('admin-crop-modal').classList.add('flex');
            drawAdminCropCanvas();
        };
        img.src = canvas.toDataURL('image/jpeg');
    });

    document.getElementById('admin-crop-close-btn')?.addEventListener('click', () => {
        document.getElementById('admin-crop-modal').classList.add('hidden');
        document.getElementById('admin-crop-modal').classList.remove('flex');
    });
    document.getElementById('admin-crop-cancel-btn')?.addEventListener('click', () => {
        document.getElementById('admin-crop-modal').classList.add('hidden');
        document.getElementById('admin-crop-modal').classList.remove('flex');
    });

    const zoomInput = document.getElementById('admin-crop-zoom');
    const panXInput = document.getElementById('admin-crop-panx');
    const panYInput = document.getElementById('admin-crop-pany');

    zoomInput?.addEventListener('input', (e) => {
        adminCropZoom = parseFloat(e.target.value);
        document.getElementById('admin-zoom-label').textContent = adminCropZoom.toFixed(1) + 'x';
        drawAdminCropCanvas();
    });
    panXInput?.addEventListener('input', (e) => {
        adminCropPanX = parseInt(e.target.value);
        drawAdminCropCanvas();
    });
    panYInput?.addEventListener('input', (e) => {
        adminCropPanY = parseInt(e.target.value);
        drawAdminCropCanvas();
    });

    document.getElementById('admin-crop-save-btn')?.addEventListener('click', () => {
        const canvas = document.getElementById('admin-crop-canvas');
        if (!canvas) return;
        let quality = 0.9;
        let base64 = canvas.toDataURL('image/jpeg', quality);

        // Compress base64 size to strictly under 50KB (approx 50 * 1024 bytes)
        while (base64.length * 0.75 > 50 * 1024 && quality > 0.1) {
            quality -= 0.1;
            base64 = canvas.toDataURL('image/jpeg', quality);
        }

        // If still over 50KB, scale down resolution iteratively
        let currentWidth = 150;
        let currentHeight = 150;
        while (base64.length * 0.75 > 50 * 1024 && currentWidth > 60) {
            currentWidth -= 15;
            currentHeight -= 15;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = currentWidth;
            tempCanvas.height = currentHeight;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
            base64 = tempCanvas.toDataURL('image/jpeg', 0.6);
        }

        document.getElementById('admin-crop-modal').classList.add('hidden');
        document.getElementById('admin-crop-modal').classList.remove('flex');

        // Save result to hidden input
        document.getElementById(activePhotoTargetInputId).value = base64;

        // Update Preview UI
        const preview = document.getElementById(activePhotoTargetPreviewId);
        const placeholder = document.getElementById(activePhotoTargetPlaceholderId);
        const removeBtn = document.getElementById(activePhotoTargetRemoveBtnId);

        if (preview) {
            preview.src = base64;
            preview.classList.remove('hidden');
        }
        if (placeholder) {
            placeholder.classList.add('hidden');
        }
        if (removeBtn) {
            removeBtn.classList.remove('hidden');
        }
    });
};

// Run initialization immediately!
setTimeout(initAllAdminPhotoWidgets, 200);

// --- 1. STAFF MANAGEMENT ---
const CORE_STAFF_TYPES = ['Teacher', 'Management'];

const DEFAULT_STAFF_CATEGORY_FIELDS = [
    { id: 'core_photo', key: 'photo', label: 'Staff Photo (Upload & Mobile Camera)', type: 'photo', required: false, locked: false, order: 1 },
    { id: 'core_name', key: 'name', label: 'Full Name', type: 'text', required: true, locked: true, order: 2 },
    { id: 'core_role', key: 'role', label: 'Role / Designation / Subject', type: 'text', required: true, locked: false, order: 3 },
    { id: 'core_phone', key: 'phone', label: 'Phone Number', type: 'phone', required: false, locked: false, order: 4 },
    { id: 'core_email', key: 'email', label: 'Login Email (For Portal Login)', type: 'email', required: false, locked: false, order: 5 },
    { id: 'core_password', key: 'password', label: 'Login Password', type: 'text', required: false, locked: false, order: 6 },
    { id: 'core_msr', key: 'msr', label: 'MSR Number', type: 'text', required: false, locked: false, order: 7 },
    { id: 'core_address', key: 'address', label: 'Permanent Address', type: 'textarea', required: false, locked: false, order: 8 }
];

const getDefaultCoreCategoryDef = (typeId = 'Teacher') => ({
    id: typeId,
    name: typeId,
    order: typeId === 'Teacher' ? 1 : 2,
    showPublic: true,
    isCore: true,
    fields: DEFAULT_STAFF_CATEGORY_FIELDS.map((f) => ({ ...f }))
});

const getAllStaffCategories = () => {
    const rawList = Array.isArray(webContent.directoryCategories) ? webContent.directoryCategories : [];
    const normalizedMap = new Map();

    // Ensure Teacher and Management always exist as editable categories
    CORE_STAFF_TYPES.forEach((coreId) => {
        const saved = rawList.find((c) => c.id === coreId || String(c.name || '').trim().toLowerCase() === coreId.toLowerCase());
        if (saved) {
            normalizedMap.set(coreId, {
                ...normalizeDirectoryCategory(saved),
                id: coreId,
                name: String(saved.name || coreId).trim() || coreId,
                isCore: true
            });
        } else {
            normalizedMap.set(coreId, getDefaultCoreCategoryDef(coreId));
        }
    });

    // Include custom categories
    rawList.forEach((item) => {
        if (!item) return;
        const isCoreMatch = CORE_STAFF_TYPES.some((coreId) => item.id === coreId || String(item.name || '').trim().toLowerCase() === coreId.toLowerCase());
        if (isCoreMatch) return;
        const norm = normalizeDirectoryCategory(item);
        normalizedMap.set(norm.id, { ...norm, isCore: false });
    });

    return Array.from(normalizedMap.values()).sort((a, b) => a.order - b.order);
};

const getActiveFieldsForCategory = (categoryId = 'Teacher') => {
    const allCats = getAllStaffCategories();
    const matched = allCats.find((c) => c.id === categoryId) || getDefaultCoreCategoryDef(categoryId);
    const fields = Array.isArray(matched.fields) && matched.fields.length
        ? [...matched.fields].sort((a, b) => (Number(a.order) || 1) - (Number(b.order) || 1))
        : DEFAULT_STAFF_CATEGORY_FIELDS;
    return fields;
};

const getStaffTypeLabel = (type = '') => {
    const match = getAllStaffCategories().find((category) => category.id === type);
    if (match) return match.name;
    if (CORE_STAFF_TYPES.includes(type)) return type;
    return type || 'Staff';
};

const getStaffTypeOptions = () => getAllStaffCategories().map((category) => ({
    value: category.id,
    label: category.name
}));

const captureDynamicStaffFormValues = (prefix = 'st') => {
    const container = document.getElementById(`${prefix}-dynamic-fields-container`);
    if (!container) return {};
    const values = {};
    container.querySelectorAll('[data-staff-field-key]').forEach((el) => {
        const key = el.dataset.staffFieldKey;
        if (key) values[key] = el.value || '';
    });
    return values;
};

const renderDynamicStaffFormFields = (prefix = 'st', categoryId = 'Teacher', initialValues = null) => {
    const container = document.getElementById(`${prefix}-dynamic-fields-container`);
    if (!container) return;
    const preserved = initialValues !== null ? initialValues : captureDynamicStaffFormValues(prefix);
    const fields = getActiveFieldsForCategory(categoryId);
    const catLabel = getStaffTypeLabel(categoryId);
    const badgeEl = document.getElementById(`${prefix}-active-category-badge`);
    if (badgeEl) badgeEl.textContent = `Category: ${catLabel} (${fields.length} Fields)`;

    const photoField = fields.find((f) => f.key === 'photo' || f.type === 'photo');
    const otherFields = fields.filter((f) => f.key !== 'photo' && f.type !== 'photo');

    let html = '';

    if (photoField) {
        const photoVal = String(preserved.photo || '');
        const inputId = `${prefix}-photo`;
        const previewId = `${prefix}-photo-preview`;
        const placeholderId = `${prefix}-photo-placeholder`;
        const removeBtnId = `${prefix}-remove-btn`;
        const fileInputId = `${prefix}-file-input`;
        const cameraBtnId = `${prefix}-camera-btn`;
        const uploadBtnId = `${prefix}-upload-btn`;

        html += `
        <div class="flex flex-col sm:flex-row gap-4 bg-gray-50 p-4 rounded-xl border border-gray-200 items-center">
            <div class="relative w-20 h-20 rounded-full border-2 border-slate-200 overflow-hidden bg-slate-100 flex items-center justify-center shrink-0 shadow-inner">
                <img id="${previewId}" src="${escapeHtml(photoVal)}" class="w-full h-full object-cover ${photoVal ? '' : 'hidden'}" alt="Staff Profile Preview">
                <i id="${placeholderId}" class="fas fa-user text-3xl text-slate-400 ${photoVal ? 'hidden' : ''}"></i>
            </div>
            <div class="flex-1 text-center sm:text-left space-y-1.5">
                <label class="block text-xs font-black text-slate-700">${escapeHtml(photoField.label || 'Staff Photo')} (Max 50KB) ${photoField.required ? '<span class="mandatory-star">*</span>' : ''}</label>
                <div class="flex flex-wrap gap-2 justify-center sm:justify-start">
                    <button type="button" id="${cameraBtnId}" class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-md font-bold text-xs flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-camera"></i> Camera</button>
                    <button type="button" id="${uploadBtnId}" class="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-md font-bold text-xs flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-upload"></i> Upload</button>
                    <button type="button" id="${removeBtnId}" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-md font-bold text-xs transition-all ${photoVal ? '' : 'hidden'}">Remove</button>
                </div>
                <input type="hidden" id="${inputId}" data-staff-field-key="photo" data-staff-field-required="${photoField.required ? 'true' : 'false'}" data-staff-field-label="${escapeHtml(photoField.label || 'Photo')}" value="${escapeHtml(photoVal)}">
                <input type="file" id="${fileInputId}" accept="image/*" class="hidden">
            </div>
        </div>`;
    }

    if (otherFields.length) {
        html += `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">`;
        otherFields.forEach((field, idx) => {
            const key = field.key;
            const val = String(preserved[key] ?? (preserved.customFields?.[key] ?? ''));
            const reqStar = field.required ? ' <span class="mandatory-star">*</span>' : '';
            const fieldId = `${prefix}-field-${key}`;
            const isFullWidth = field.type === 'textarea' || key === 'address';
            const isCredentialField = key === 'email' || key === 'password';
            const wrapperClass = isFullWidth
                ? 'md:col-span-2'
                : isCredentialField
                    ? 'bg-blue-50/70 p-3 rounded-xl border border-blue-100'
                    : '';

            if (field.type === 'textarea' || key === 'address') {
                html += `
                <div class="${wrapperClass}">
                    <label for="${fieldId}" class="block text-sm font-semibold text-gray-800 mb-1">${idx + 2}. ${escapeHtml(field.label)}${reqStar}</label>
                    <textarea id="${fieldId}" data-staff-field-key="${escapeHtml(key)}" data-staff-field-required="${field.required ? 'true' : 'false'}" data-staff-field-label="${escapeHtml(field.label)}" rows="2" class="w-full p-2.5 border border-gray-300 rounded-lg bg-white" placeholder="${escapeHtml(field.label)}">${escapeHtml(val)}</textarea>
                </div>`;
            } else {
                const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text';
                const iconHtml = key === 'email' ? '<i class="fas fa-envelope text-blue-600 mr-1"></i>' : key === 'password' ? '<i class="fas fa-key text-blue-600 mr-1"></i>' : '';
                html += `
                <div class="${wrapperClass}">
                    <label for="${fieldId}" class="block text-sm font-semibold ${isCredentialField ? 'text-blue-900' : 'text-gray-800'} mb-1">${iconHtml}${idx + 2}. ${escapeHtml(field.label)}${reqStar}</label>
                    <input type="${inputType}" id="${fieldId}" data-staff-field-key="${escapeHtml(key)}" data-staff-field-required="${field.required ? 'true' : 'false'}" data-staff-field-label="${escapeHtml(field.label)}" value="${escapeHtml(val)}" class="w-full p-2.5 border border-gray-300 rounded-lg bg-white" placeholder="${escapeHtml(field.label)}">
                </div>`;
            }
        });
        html += `</div>`;
    }

    container.innerHTML = html;

    if (photoField) {
        setupAdminPhotoWidget(
            `${prefix}-photo`,
            `${prefix}-photo-preview`,
            `${prefix}-photo-placeholder`,
            `${prefix}-remove-btn`,
            `${prefix}-file-input`,
            `${prefix}-camera-btn`,
            `${prefix}-upload-btn`
        );
    }
};

const renderStaffTypeControls = () => {
    const options = getStaffTypeOptions();
    ['st-type', 'e-st-type'].forEach((id) => {
        const select = document.getElementById(id);
        if (!select) return;
        const previous = select.value;
        select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
        if (options.some((option) => option.value === previous)) {
            select.value = previous;
        } else if (options.length) {
            select.value = options[0].value;
        }
    });
    const filter = document.getElementById('staff-filter-type');
    if (filter) {
        const previous = filter.value || 'all';
        filter.innerHTML = '<option value="all">All Types</option>' + options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
        filter.value = options.some((option) => option.value === previous) ? previous : 'all';
    }
    const currentAddType = document.getElementById('st-type')?.value || 'Teacher';
    renderDynamicStaffFormFields('st', currentAddType);
};

document.getElementById('st-type')?.addEventListener('change', (e) => {
    renderDynamicStaffFormFields('st', e.target.value);
});
document.getElementById('e-st-type')?.addEventListener('change', (e) => {
    renderDynamicStaffFormFields('e-st', e.target.value);
});

const extractAndValidateStaffForm = (prefix = 'st') => {
    const type = document.getElementById(`${prefix}-type`)?.value || 'Teacher';
    const container = document.getElementById(`${prefix}-dynamic-fields-container`);
    const fieldElements = Array.from(container?.querySelectorAll('[data-staff-field-key]') || []);
    const values = {};
    const customFields = {};
    const standardKeys = new Set(['name', 'role', 'phone', 'email', 'password', 'msr', 'address', 'photo']);

    for (const el of fieldElements) {
        const key = el.dataset.staffFieldKey;
        const required = el.dataset.staffFieldRequired === 'true';
        const label = el.dataset.staffFieldLabel || key;
        const val = String(el.value || '').trim();
        if (required && !val) {
            alert(`"${label}" is required!`);
            el.focus?.();
            return null;
        }
        values[key] = val;
        if (!standardKeys.has(key)) {
            customFields[key] = val;
        }
    }

    const name = String(values.name || '').trim();
    if (!type || !name) {
        alert('Type and Full Name are mandatory!');
        return null;
    }

    const isActive = document.getElementById(`${prefix}-active`)?.checked !== false;
    const showPublic = document.getElementById(`${prefix}-show-public`)?.checked !== false;
    const canCollect = document.getElementById(`${prefix}-can-collect`)?.checked === true;
    const canAccessWorksheet = document.getElementById(`${prefix}-can-worksheet`)?.checked !== false;
    const canManageResults = document.getElementById(`${prefix}-can-manage-results`)?.checked === true;
    const canAccessAdmin = document.getElementById(`${prefix}-can-access-admin`)?.checked === true;
    const actLikeSuperAdmin = canAccessAdmin && (document.getElementById(`${prefix}-act-like-super-admin`)?.checked === true);
    const displayOrder = Math.max(1, Number(document.getElementById(`${prefix}-display-order`)?.value || 999));

    const hasAnyPortalAccess = canCollect || canAccessWorksheet || canManageResults || canAccessAdmin;
    const passwordInputExists = fieldElements.some((el) => el.dataset.staffFieldKey === 'password');
    const existingStaffForValidation = (prefix === 'e-st' && editingStaffId) ? allStaff.find((st) => st.id === editingStaffId) : null;
    const effectivePassword = values.password || existingStaffForValidation?.password || '';
    if (hasAnyPortalAccess && passwordInputExists && values.email && !effectivePassword) {
        alert('Please provide a Login Password when granting portal access.');
        return null;
    }

    return {
        type,
        name,
        role: String(values.role || '').trim(),
        phone: String(values.phone || '').trim(),
        email: String(values.email || '').trim(),
        password: String(values.password || '').trim(),
        msr: String(values.msr || '').trim(),
        address: String(values.address || '').trim(),
        photo: String(values.photo || '').trim(),
        customFields,
        isActive,
        showPublic,
        canCollect,
        canAccessWorksheet,
        canManageResults,
        canAccessAdmin,
        actLikeSuperAdmin,
        displayOrder,
        updatedAt: Date.now()
    };
};

document.getElementById('add-staff-btn').addEventListener('click', async () => {
    if(!requirePermission('staff.manage')) return;
    const staffRecord = extractAndValidateStaffForm('st');
    if (!staffRecord) return;
    if(!confirm("Add new staff member?")) return;
    const btn = document.getElementById('add-staff-btn'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

    const staffDoc = await addDoc(collection(db, `${BASE_PATH}/staff`), staffRecord);
    await syncStaffAccessRecord(staffRecord);
    await logAuditEvent({ category: 'security', action: 'staff.create', entityType: 'staff', entityId: staffDoc.id, message: `Staff added: ${staffRecord.name}.` });
    alert("Staff Added Successfully!");
    renderDynamicStaffFormFields('st', staffRecord.type, {});
    document.getElementById('st-display-order').value = '999';
    document.getElementById('st-active').checked = true;
    document.getElementById('st-show-public').checked = true;
    document.getElementById('st-can-collect').checked = true;
    document.getElementById('st-can-worksheet').checked = true;
    document.getElementById('st-can-manage-results').checked = false;
    document.getElementById('st-can-access-admin').checked = false;
    const stSuperEl = document.getElementById('st-act-like-super-admin');
    if (stSuperEl) stSuperEl.checked = false;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus mr-2"></i> Add Staff';
});

const renderStaffList = () => {
    renderStaffTypeControls();
    const actTCont = document.getElementById('active-teachers-list');
    const actMCont = document.getElementById('active-mgmt-list');
    const categoryCont = document.getElementById('active-category-staff-list');
    const inactCont = document.getElementById('inactive-staff-container');
    const typeFilter = document.getElementById('staff-filter-type')?.value || 'all';
    const searchTerm = String(document.getElementById('staff-filter-search')?.value || '').trim().toLowerCase();
    const matchesFilters = (staffMember) => {
        if (typeFilter !== 'all' && staffMember.type !== typeFilter) return false;
        if (!searchTerm) return true;
        const haystack = `${staffMember.name || ''} ${staffMember.role || ''} ${staffMember.phone || ''} ${staffMember.email || ''} ${getStaffTypeLabel(staffMember.type)}`.toLowerCase();
        return haystack.includes(searchTerm);
    };
    const active = allStaff.filter((s) => s.isActive && matchesFilters(s));
    const inactive = allStaff.filter((s) => !s.isActive && matchesFilters(s));
    const sortByDisplayOrder = (list = []) => [...list].sort((a, b) => {
        const orderDiff = Number(a?.displayOrder || 999) - Number(b?.displayOrder || 999);
        if (orderDiff !== 0) return orderDiff;
        return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
    const buildHTML = (list, isAct) => list.map((staffMember) => {
        const safePhoto = resolveSafePhotoUrl(staffMember.photo, 'https://via.placeholder.com/60?text=Staff');
        const typeLabel = getStaffTypeLabel(staffMember.type);
        const categoryFields = getActiveFieldsForCategory(staffMember.type);
        const customBadges = categoryFields
            .filter((f) => !['name', 'role', 'photo', 'email', 'password'].includes(f.key))
            .map((f) => {
                const val = staffMember[f.key] ?? staffMember.customFields?.[f.key] ?? '';
                if (!val) return '';
                return `<span class="text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded font-medium">${escapeHtml(f.label)}: ${escapeHtml(String(val))}</span>`;
            })
            .filter(Boolean)
            .join('');

        const dutyClasses = Array.isArray(staffMember.dutyClasses) ? staffMember.dutyClasses.filter(Boolean) : [];
        const dutyClassBadges = dutyClasses.length
            ? dutyClasses.map((cls) => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200"><i class="fas fa-school mr-1"></i>${escapeHtml(cls)}</span>`).join(' ')
            : '<span class="text-[10px] text-gray-400 italic">No classes assigned</span>';

        const hasUpi = staffMember.dutyPaymentDetails && (staffMember.dutyPaymentDetails.upiId || staffMember.dutyPaymentDetails.upiNumber);
        const upiBadge = hasUpi
            ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200" title="UPI: ${escapeHtml(staffMember.dutyPaymentDetails.upiId || staffMember.dutyPaymentDetails.upiNumber)}"><i class="fas fa-wallet mr-1"></i>UPI Set</span>`
            : '';

        return `
            <div class="flex flex-col justify-between p-4 bg-white border border-gray-200 rounded-xl shadow-xs items-stretch gap-3 transition hover:shadow-md mb-2">
                <!-- Top Header: Photo, Name, Role on left; View button on right -->
                <div class="flex items-start justify-between gap-3 border-b border-gray-100 pb-3">
                    <div class="flex items-center gap-3 min-w-0">
                        <img src="${safePhoto}" class="w-12 h-12 rounded-full object-cover shrink-0 border-2 ${staffMember.type === 'Teacher' ? 'border-blue-200' : staffMember.type === 'Management' ? 'border-purple-200' : 'border-emerald-200'}" alt="${escapeHtml(staffMember.name || 'Staff')}">
                        <div class="min-w-0">
                            <div class="font-bold text-gray-900 text-base leading-tight truncate">${escapeHtml(staffMember.name || '--')}</div>
                            <div class="text-xs text-gray-500 font-semibold mt-0.5 truncate">${escapeHtml(staffMember.role || typeLabel || '--')}</div>
                        </div>
                    </div>
                    <button class="staff-action-btn shrink-0 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-2xs" data-action="view" data-id="${staffMember.id}" title="View Full Details">
                        <i class="fas fa-eye text-xs"></i> <span>View</span>
                    </button>
                </div>

                <!-- Assigned Classes -->
                <div class="space-y-1">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Classes:</div>
                    <div class="flex flex-wrap gap-1.5 items-center">
                        ${dutyClassBadges}
                        ${upiBadge}
                    </div>
                </div>

                <!-- Login Permissions Only -->
                <div class="space-y-1">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Login Permissions:</div>
                    <div class="flex flex-wrap gap-1.5">
                        ${staffMember.canCollect !== false ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">1. Collection</span>' : ''}
                        ${staffMember.canAccessWorksheet !== false ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">2. Worksheet</span>' : ''}
                        ${staffMember.canManageResults ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">3. Result</span>' : ''}
                        ${staffMember.canAccessAdmin ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">4. Admin${staffMember.actLikeSuperAdmin ? ' (Super)' : ''}</span>` : ''}
                        ${(staffMember.canCollect === false && staffMember.canAccessWorksheet === false && !staffMember.canManageResults && !staffMember.canAccessAdmin) ? '<span class="text-[10px] text-gray-400 italic">No permissions</span>' : ''}
                    </div>
                </div>

                <!-- Bottom Action Buttons: Single row, icon on top, name underneath -->
                <div class="pt-3 border-t border-gray-100 grid grid-cols-5 gap-1.5 text-center">
                    <button type="button" class="staff-action-btn flex flex-col items-center justify-center p-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 transition shadow-2xs group cursor-pointer" data-action="delete" data-id="${staffMember.id}" title="Delete Staff">
                        <i class="fas fa-trash text-sm mb-1 group-hover:scale-110 transition-transform"></i>
                        <span class="text-[10px] font-bold leading-tight">Delete</span>
                    </button>
                    <button type="button" class="staff-action-btn flex flex-col items-center justify-center p-2 rounded-lg ${isAct ? 'bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200'} transition shadow-2xs group cursor-pointer" data-action="toggle" data-id="${staffMember.id}" data-next-state="${isAct ? 'false' : 'true'}" title="${isAct ? 'Deactivate' : 'Activate'}">
                        <i class="fas ${isAct ? 'fa-user-slash' : 'fa-user-check'} text-sm mb-1 group-hover:scale-110 transition-transform"></i>
                        <span class="text-[10px] font-bold leading-tight">${isAct ? 'Deactive' : 'Active'}</span>
                    </button>
                    <button type="button" class="staff-action-btn flex flex-col items-center justify-center p-2 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 transition shadow-2xs group cursor-pointer" data-action="credential" data-id="${staffMember.id}" title="Login Credentials">
                        <i class="fas fa-key text-sm mb-1 group-hover:scale-110 transition-transform"></i>
                        <span class="text-[10px] font-bold leading-tight">Login</span>
                    </button>
                    <button type="button" class="staff-action-btn flex flex-col items-center justify-center p-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 transition shadow-2xs group cursor-pointer" data-action="duty" data-id="${staffMember.id}" title="Duty Classes & UPI">
                        <i class="fas fa-school text-sm mb-1 group-hover:scale-110 transition-transform"></i>
                        <span class="text-[10px] font-bold leading-tight truncate w-full">Duty &amp; UPI</span>
                    </button>
                    <button type="button" class="staff-action-btn flex flex-col items-center justify-center p-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 transition shadow-2xs group cursor-pointer" data-action="edit" data-id="${staffMember.id}" title="Edit Staff Details">
                        <i class="fas fa-edit text-sm mb-1 group-hover:scale-110 transition-transform"></i>
                        <span class="text-[10px] font-bold leading-tight">Edit</span>
                    </button>
                </div>
            </div>`;
    }).join('');
    const activeTeachers = sortByDisplayOrder(active.filter((s) => s.type === 'Teacher'));
    const activeManagement = sortByDisplayOrder(active.filter((s) => s.type === 'Management'));
    actTCont.innerHTML = activeTeachers.length ? buildHTML(activeTeachers, true) : '<p class="text-sm text-gray-500 italic p-2">No active teachers found.</p>';
    actMCont.innerHTML = activeManagement.length ? buildHTML(activeManagement, true) : '<p class="text-sm text-gray-500 italic p-2">No active management found.</p>';
    const customCategories = getAllStaffCategories().filter((c) => !CORE_STAFF_TYPES.includes(c.id));
    const categorySections = customCategories.map((category) => {
        const rows = sortByDisplayOrder(active.filter((s) => s.type === category.id));
        return `<div class="card p-5 rounded-xl shadow-sm border border-emerald-100"><h2 class="text-xl font-bold mb-4 text-emerald-800 border-b border-emerald-100 pb-2"><i class="fas fa-users mr-2"></i>${escapeHtml(category.name)}</h2>${rows.length ? `<div class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">${buildHTML(rows, true)}</div>` : '<p class="text-sm text-gray-500 italic p-2">No active profiles in this category.</p>'}</div>`;
    }).join('');
    if (categoryCont) categoryCont.innerHTML = categorySections;
    const inactiveSections = getStaffTypeOptions().map((option) => {
        const rows = sortByDisplayOrder(inactive.filter((s) => s.type === option.value));
        return `<h4 class="font-bold text-gray-700 mb-2 border-b pb-1">Inactive ${escapeHtml(option.label)}</h4><div class="mb-4">${rows.length ? `<div class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">${buildHTML(rows, false)}</div>` : '<p class="text-sm text-gray-500 italic">No inactive profiles.</p>'}</div>`;
    }).join('');
    inactCont.innerHTML = inactiveSections;
};

window.openStaffDetailsModal = (id) => {
    const s = allStaff.find(st => st.id === id);
    if (!s) return;
    const modal = document.getElementById('staff-details-popup');
    const container = document.getElementById('staff-details-content');
    if (!modal || !container) return;

    const safePhoto = resolveSafePhotoUrl(s.photo, 'https://via.placeholder.com/80?text=Staff');
    const typeLabel = getStaffTypeLabel(s.type);
    const categoryFields = getActiveFieldsForCategory(s.type);

    const extraFieldsHtml = categoryFields
        .filter((f) => !['name', 'role', 'photo', 'email', 'password', 'phone', 'address'].includes(f.key))
        .map((f) => {
            const val = s[f.key] ?? s.customFields?.[f.key] ?? '';
            if (!val) return '';
            return `<div class="bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                <span class="block text-[10px] font-bold uppercase text-gray-500">${escapeHtml(f.label)}</span>
                <span class="text-xs font-bold text-gray-800">${escapeHtml(String(val))}</span>
            </div>`;
        })
        .filter(Boolean)
        .join('');

    const dutyClasses = Array.isArray(s.dutyClasses) ? s.dutyClasses.filter(Boolean) : [];
    const dutyClassBadges = dutyClasses.length
        ? dutyClasses.map((cls) => `<span class="text-xs font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200"><i class="fas fa-school mr-1"></i>${escapeHtml(cls)}</span>`).join(' ')
        : '<span class="text-xs text-gray-400 italic">None assigned</span>';

    const upiInfo = s.dutyPaymentDetails && (s.dutyPaymentDetails.upiId || s.dutyPaymentDetails.upiNumber)
        ? `ID: ${s.dutyPaymentDetails.upiId || '--'}, Number: ${s.dutyPaymentDetails.upiNumber || '--'}`
        : 'Not configured';

    container.innerHTML = `
        <div class="flex items-center gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
            <img src="${safePhoto}" class="w-16 h-16 rounded-full object-cover border-2 border-blue-200 shrink-0" alt="${escapeHtml(s.name || 'Staff')}">
            <div class="min-w-0">
                <h4 class="text-lg font-extrabold text-gray-900 leading-tight">${escapeHtml(s.name || '--')}</h4>
                <div class="text-xs font-bold text-blue-700 mt-0.5">${escapeHtml(s.role || typeLabel || '--')}</div>
                <div class="flex items-center gap-1.5 mt-1">
                    <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-white border border-slate-200 text-slate-700">${escapeHtml(typeLabel)}</span>
                    <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${s.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'}">${s.isActive ? 'Active' : 'Inactive'}</span>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                <span class="block text-[10px] font-bold uppercase text-gray-500">Phone Number</span>
                <span class="text-xs font-bold text-gray-800">${escapeHtml(s.phone || 'Not provided')}</span>
            </div>
            <div class="bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                <span class="block text-[10px] font-bold uppercase text-gray-500">Email Address</span>
                <span class="text-xs font-bold text-gray-800">${escapeHtml(s.email || 'Not provided')}</span>
            </div>
        </div>

        ${s.address ? `
        <div class="bg-gray-50 p-2.5 rounded-lg border border-gray-100">
            <span class="block text-[10px] font-bold uppercase text-gray-500">Address</span>
            <span class="text-xs text-gray-800 font-medium">${escapeHtml(s.address)}</span>
        </div>` : ''}

        ${extraFieldsHtml ? `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${extraFieldsHtml}
        </div>` : ''}

        <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-2">
            <div>
                <span class="block text-[10px] font-bold uppercase text-slate-500">Assigned Duty Classes</span>
                <div class="flex flex-wrap gap-1.5 mt-1">${dutyClassBadges}</div>
            </div>
            <div class="pt-2 border-t border-slate-200">
                <span class="block text-[10px] font-bold uppercase text-slate-500">UPI Payment Details</span>
                <span class="text-xs font-semibold text-slate-700">${escapeHtml(upiInfo)}</span>
            </div>
        </div>

        <div class="bg-indigo-50/50 p-3 rounded-xl border border-indigo-100">
            <span class="block text-[10px] font-bold uppercase text-indigo-700 mb-1.5">Portal Access Permissions</span>
            <div class="flex flex-wrap gap-1.5">
                ${s.canCollect !== false ? '<span class="text-xs font-bold px-2.5 py-1 rounded-md bg-green-100 text-green-800 border border-green-200">1. Fee Collection</span>' : ''}
                ${s.canAccessWorksheet !== false ? '<span class="text-xs font-bold px-2.5 py-1 rounded-md bg-blue-100 text-blue-800 border border-blue-200">2. Class Worksheet</span>' : ''}
                ${s.canManageResults ? '<span class="text-xs font-bold px-2.5 py-1 rounded-md bg-indigo-100 text-indigo-800 border border-indigo-200">3. Result Portal</span>' : ''}
                ${s.canAccessAdmin ? `<span class="text-xs font-bold px-2.5 py-1 rounded-md bg-violet-100 text-violet-800 border border-violet-200">4. Admin Panel${s.actLikeSuperAdmin ? ' (Super)' : ''}</span>` : ''}
            </div>
        </div>
    `;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

document.getElementById('staff-details-close-btn')?.addEventListener('click', () => {
    document.getElementById('staff-details-popup')?.classList.add('hidden');
    document.getElementById('staff-details-popup')?.classList.remove('flex');
});
document.getElementById('staff-details-close-footer')?.addEventListener('click', () => {
    document.getElementById('staff-details-popup')?.classList.add('hidden');
    document.getElementById('staff-details-popup')?.classList.remove('flex');
});

const handleStaffActionClick = (e) => {
    const button = e.target.closest('.staff-action-btn');
    if (!button) return;
    const { action, id, nextState } = button.dataset;
    if (action === 'view') window.openStaffDetailsModal(id);
    if (action === 'duty') window.openStaffDutyModal(id);
    if (action === 'edit') window.openEditStaff(id);
    if (action === 'credential') window.resetStaffCredentials(id);
    if (action === 'toggle') window.toggleStaffStatus(id, nextState === 'true');
    if (action === 'delete') window.deleteStaff(id);
};
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.staff-action-btn');
    if (btn) {
        handleStaffActionClick(e);
    }
});

window.openEditStaff = (id) => {
    if(!requirePermission('staff.manage')) return;
    const staffRecord = allStaff.find(st => st.id === id);
    if (!staffRecord) return;

    editingStaffId = id;
    renderStaffTypeControls();

    const typeSelect = document.getElementById('e-st-type');
    if (typeSelect) {
        typeSelect.value = staffRecord.type || 'Teacher';
    }

    const badge = document.getElementById('e-st-active-category-badge');
    if (badge) {
        badge.textContent = `Category: ${getStaffTypeLabel(staffRecord.type)}`;
    }

    const orderInput = document.getElementById('e-st-display-order');
    if (orderInput) {
        orderInput.value = staffRecord.displayOrder || 999;
    }

    const activeCheck = document.getElementById('e-st-active');
    if (activeCheck) activeCheck.checked = staffRecord.isActive !== false;

    const publicCheck = document.getElementById('e-st-show-public');
    if (publicCheck) publicCheck.checked = staffRecord.showPublic !== false;

    const collectCheck = document.getElementById('e-st-can-collect');
    if (collectCheck) collectCheck.checked = staffRecord.canCollect !== false;

    const worksheetCheck = document.getElementById('e-st-can-worksheet');
    if (worksheetCheck) worksheetCheck.checked = staffRecord.canAccessWorksheet !== false;

    const resultsCheck = document.getElementById('e-st-can-manage-results');
    if (resultsCheck) resultsCheck.checked = staffRecord.canManageResults === true;

    const adminCheck = document.getElementById('e-st-can-access-admin');
    if (adminCheck) adminCheck.checked = staffRecord.canAccessAdmin === true;

    const superAdminCheck = document.getElementById('e-st-act-like-super-admin');
    if (superAdminCheck) superAdminCheck.checked = staffRecord.actLikeSuperAdmin === true;

    renderDynamicStaffFormFields('e-st', staffRecord.type || 'Teacher', staffRecord);

    const popup = document.getElementById('edit-staff-popup');
    if (popup) {
        popup.classList.remove('hidden');
        popup.classList.add('flex');
    }
};

window.openStaffDutyModal = (id) => {
    if(!requirePermission('staff.manage')) return;
    const staffRecord = allStaff.find(st => st.id === id);
    if (!staffRecord) return;

    const popup = document.getElementById('staff-duty-popup');
    if (!popup) return;

    document.getElementById('staff-duty-staff-id').value = staffRecord.id;
    const subEl = document.getElementById('staff-duty-subtitle');
    if (subEl) {
        subEl.textContent = `Staff: ${staffRecord.name || '--'} (${getStaffTypeLabel(staffRecord.type)} - ${staffRecord.role || 'Staff'})`;
    }

    const grid = document.getElementById('staff-duty-classes-grid');
    if (grid) {
        const activeYearClasses = getClassesForActiveYear() || [];
        const allYearClasses = (academicYears || []).flatMap((y) => Array.isArray(y.classes) ? y.classes : []);
        const studentClasses = (rawStudents || []).map((s) => s.class).filter(Boolean);
        const existingDutyClasses = Array.isArray(staffRecord.dutyClasses) ? staffRecord.dutyClasses.filter(Boolean) : [];
        let dutyClassList = sortClassLabels([...new Set([...activeYearClasses, ...allYearClasses, ...studentClasses, ...existingDutyClasses])]);
        if (!dutyClassList.length && typeof getDefaultClassLadder === 'function') {
            dutyClassList = getDefaultClassLadder();
        }
        if (!dutyClassList.length) {
            grid.innerHTML = '<p class="col-span-full text-xs text-gray-500 italic p-2">No classes configured for active academic year. Please add classes in Classes &amp; Divisions first.</p>';
        } else {
            grid.innerHTML = dutyClassList.map((cls) => {
                const checked = existingDutyClasses.includes(cls) ? 'checked' : '';
                return `
                    <label class="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold cursor-pointer hover:bg-blue-50 transition">
                        <input type="checkbox" class="staff-duty-checkbox w-4 h-4 text-indigo-600 rounded" value="${escapeHtml(cls)}" ${checked}>
                        <span class="text-slate-800 truncate">${escapeHtml(cls)}</span>
                    </label>
                `;
            }).join('');
        }
    }

    const payDetails = staffRecord.dutyPaymentDetails || {};
    const accInput = document.getElementById('staff-duty-account-name');
    const numInput = document.getElementById('staff-duty-upi-number');
    const idInput = document.getElementById('staff-duty-upi-id');
    if (accInput) accInput.value = payDetails.accountName || '';
    if (numInput) numInput.value = payDetails.upiNumber || '';
    if (idInput) idInput.value = payDetails.upiId || '';

    popup.classList.remove('hidden');
    popup.classList.add('flex');
};

const closeStaffDutyModal = () => {
    const popup = document.getElementById('staff-duty-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }
};

document.getElementById('staff-duty-close-btn')?.addEventListener('click', closeStaffDutyModal);
document.getElementById('staff-duty-cancel-btn')?.addEventListener('click', closeStaffDutyModal);

document.getElementById('staff-duty-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.staff-duty-checkbox').forEach((cb) => { cb.checked = true; });
});

document.getElementById('staff-duty-clear-all')?.addEventListener('click', () => {
    document.querySelectorAll('.staff-duty-checkbox').forEach((cb) => { cb.checked = false; });
});

document.getElementById('staff-duty-save-btn')?.addEventListener('click', async () => {
    if(!requirePermission('staff.manage')) return;
    const staffId = document.getElementById('staff-duty-staff-id')?.value;
    if (!staffId) return;

    const staffRecord = allStaff.find(st => st.id === staffId);
    if (!staffRecord) return;

    const selectedClasses = Array.from(document.querySelectorAll('.staff-duty-checkbox:checked')).map((cb) => cb.value);
    const accountName = String(document.getElementById('staff-duty-account-name')?.value || '').trim();
    const upiNumber = String(document.getElementById('staff-duty-upi-number')?.value || '').trim();
    const upiId = String(document.getElementById('staff-duty-upi-id')?.value || '').trim();

    const dutyPaymentDetails = {
        accountName,
        upiNumber,
        upiId
    };

    const saveBtn = document.getElementById('staff-duty-save-btn');
    const originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i> Saving...';
    }

    try {
        await updateDoc(doc(db, `${BASE_PATH}/staff`, staffId), {
            dutyClasses: selectedClasses,
            dutyPaymentDetails,
            updatedAt: new Date().toISOString()
        });

        staffRecord.dutyClasses = selectedClasses;
        staffRecord.dutyPaymentDetails = dutyPaymentDetails;

        await logAuditEvent({
            category: 'staff',
            action: 'staff.duty_classes.update',
            entityType: 'staff',
            entityId: staffId,
            message: `Updated duty classes (${selectedClasses.join(', ') || 'none'}) and UPI account for ${staffRecord.name || staffId}.`
        });

        closeStaffDutyModal();
        renderStaffList();
        showToast?.('Duty classes and payment details saved successfully!', 'success');
    } catch (err) {
        console.error('Failed to update staff duty classes and payment details', err);
        alert('Failed to save duty classes and payment details. Please check connection and try again.');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = originalBtnHtml || '<i class="fas fa-save"></i> Save Details';
        }
    }
});
document.getElementById('staff-filter-search')?.addEventListener('input', renderStaffList);
document.getElementById('staff-filter-type')?.addEventListener('change', renderStaffList);
const closeEditStaffModal = () => {
    const popup = document.getElementById('edit-staff-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }
    editingStaffId = null;
};
document.getElementById('edit-staff-cancel')?.addEventListener('click', closeEditStaffModal);
document.getElementById('edit-staff-close-btn')?.addEventListener('click', closeEditStaffModal);

document.getElementById('edit-staff-update').onclick = async () => {
    if(!requirePermission('staff.manage')) return;
    if (!editingStaffId) return;
    const nextStaffRecord = extractAndValidateStaffForm('e-st');
    if (!nextStaffRecord) return;
    if(!confirm("Save changes?")) return;
    const existingStaff = allStaff.find((staffMember) => staffMember.id === editingStaffId) || {};
    const finalPassword = nextStaffRecord.password ? nextStaffRecord.password : (existingStaff.password || '');
    const mergedRecord = {
        ...existingStaff,
        ...nextStaffRecord,
        password: finalPassword,
        customFields: {
            ...(existingStaff.customFields || {}),
            ...(nextStaffRecord.customFields || {})
        }
    };
    delete mergedRecord.id;
    await updateDoc(doc(db, `${BASE_PATH}/staff`, editingStaffId), mergedRecord);
    if (existingStaff.email && normalizeEmail(existingStaff.email) !== normalizeEmail(mergedRecord.email)) {
        await removeStaffAccessRecord(existingStaff.email);
    }
    await syncStaffAccessRecord(mergedRecord);
    await logAuditEvent({ category: 'security', action: 'staff.update', entityType: 'staff', entityId: editingStaffId, message: `Staff updated: ${mergedRecord.name}.` });
    closeEditStaffModal();
    renderStaffList();
    showToast?.('Staff details updated successfully!', 'success');
};

// --- Staff Login Credentials Modal ---
window.resetStaffCredentials = (id) => {
    if (!requirePermission('staff.manage')) return;
    const staffRecord = allStaff.find((st) => st.id === id);
    if (!staffRecord) return;

    const popup = document.getElementById('staff-credentials-popup');
    if (!popup) return;

    const staffIdInput = document.getElementById('staff-cred-staff-id');
    if (staffIdInput) staffIdInput.value = staffRecord.id;

    const subEl = document.getElementById('staff-cred-subtitle');
    if (subEl) {
        subEl.textContent = `Staff: ${staffRecord.name || '--'} (${getStaffTypeLabel(staffRecord.type)} - ${staffRecord.role || 'Staff'})`;
    }

    const emailInput = document.getElementById('staff-cred-email');
    const passInput = document.getElementById('staff-cred-password');
    if (emailInput) emailInput.value = staffRecord.email || '';
    if (passInput) {
        passInput.value = staffRecord.password || '';
        passInput.type = 'password';
    }
    const eyeIcon = document.getElementById('staff-cred-eye-icon');
    if (eyeIcon) {
        eyeIcon.className = 'fas fa-eye';
    }

    popup.classList.remove('hidden');
    popup.classList.add('flex');
};

const closeStaffCredentialsModal = () => {
    const popup = document.getElementById('staff-credentials-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }
};

document.getElementById('staff-cred-close-btn')?.addEventListener('click', closeStaffCredentialsModal);
document.getElementById('staff-cred-cancel-btn')?.addEventListener('click', closeStaffCredentialsModal);

document.getElementById('staff-cred-toggle-pass')?.addEventListener('click', () => {
    const passInput = document.getElementById('staff-cred-password');
    const eyeIcon = document.getElementById('staff-cred-eye-icon');
    if (!passInput) return;
    if (passInput.type === 'password') {
        passInput.type = 'text';
        if (eyeIcon) eyeIcon.className = 'fas fa-eye-slash';
    } else {
        passInput.type = 'password';
        if (eyeIcon) eyeIcon.className = 'fas fa-eye';
    }
});

document.getElementById('staff-cred-save-btn')?.addEventListener('click', async () => {
    if (!requirePermission('staff.manage')) return;
    const staffId = document.getElementById('staff-cred-staff-id')?.value;
    if (!staffId) return;

    const staffRecord = allStaff.find((st) => st.id === staffId);
    if (!staffRecord) return;

    const rawEmail = document.getElementById('staff-cred-email')?.value || '';
    const rawPassword = document.getElementById('staff-cred-password')?.value || '';

    const normalizedNextEmail = normalizeEmail(rawEmail);
    if (!normalizedNextEmail) {
        alert('A valid email address is required.');
        return;
    }
    if (!rawPassword.trim()) {
        alert('Password cannot be empty.');
        return;
    }

    const saveBtn = document.getElementById('staff-cred-save-btn');
    const originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i> Saving...';
    }

    try {
        const nextStaffPayload = {
            ...staffRecord,
            email: normalizedNextEmail,
            password: rawPassword.trim()
        };

        await updateDoc(doc(db, `${BASE_PATH}/staff`, staffId), {
            email: normalizedNextEmail,
            password: rawPassword.trim(),
            updatedAt: new Date().toISOString()
        });

        if (staffRecord.email && normalizeEmail(staffRecord.email) !== normalizedNextEmail) {
            await removeStaffAccessRecord(staffRecord.email);
        }
        await syncStaffAccessRecord(nextStaffPayload);

        staffRecord.email = normalizedNextEmail;
        staffRecord.password = rawPassword.trim();

        await logAuditEvent({
            category: 'security',
            action: 'staff.credentials.rotate',
            entityType: 'staff',
            entityId: staffId,
            message: `Login credentials updated for ${staffRecord.name || normalizedNextEmail}`
        });

        closeStaffCredentialsModal();
        renderStaffList();
        showToast?.('Login credentials updated successfully!', 'success');
    } catch (err) {
        console.error('Failed to save staff credentials:', err);
        alert('Failed to save credentials. Please check your network connection.');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = originalBtnHtml || '<i class="fas fa-save"></i> Save Credentials';
        }
    }
});

// --- Staff Delete & Status Toggle Actions ---
window.deleteStaff = async (id) => {
    if (!requirePermission('staff.manage')) return;
    const staffRecord = allStaff.find((st) => st.id === id);
    if (!staffRecord) return;
    const staffName = staffRecord.name || 'this staff member';
    if (!confirm(`Are you sure you want to permanently delete "${staffName}"? This action cannot be undone.`)) return;

    try {
        await deleteDoc(doc(db, `${BASE_PATH}/staff`, id));
        if (staffRecord.email) {
            await removeStaffAccessRecord(staffRecord.email);
        }
        allStaff = allStaff.filter((st) => st.id !== id);
        await logAuditEvent({
            category: 'security',
            action: 'staff.delete',
            entityType: 'staff',
            entityId: id,
            message: `Staff member permanently deleted: ${staffName}`
        });
        renderStaffList();
        renderDashboard();
        showToast?.('Staff member deleted successfully!', 'success');
    } catch (err) {
        console.error('Failed to delete staff member:', err);
        alert('Failed to delete staff member. Please check your network connection and try again.');
    }
};

window.toggleStaffStatus = async (id, nextState) => {
    if (!requirePermission('staff.manage')) return;
    const staffRecord = allStaff.find((st) => st.id === id);
    if (!staffRecord) return;
    const actionLabel = nextState ? 'activate' : 'deactivate';
    const staffName = staffRecord.name || 'this staff member';
    if (!confirm(`Are you sure you want to ${actionLabel} "${staffName}"?`)) return;

    try {
        await updateDoc(doc(db, `${BASE_PATH}/staff`, id), {
            isActive: nextState,
            updatedAt: new Date().toISOString()
        });
        staffRecord.isActive = nextState;
        await syncStaffAccessRecord(staffRecord);
        await logAuditEvent({
            category: 'security',
            action: 'staff.status.toggle',
            entityType: 'staff',
            entityId: id,
            message: `Staff status changed to ${nextState ? 'Active' : 'Inactive'} for ${staffName}`
        });
        renderStaffList();
        renderDashboard();
        showToast?.(`Staff ${nextState ? 'activated' : 'deactivated'} successfully!`, 'success');
    } catch (err) {
        console.error('Failed to update staff status:', err);
        alert('Failed to update staff status. Please try again.');
    }
};

// --- 2. ADD STUDENTS ---
window.downloadCSVTemplate = () => {
    const csvData = "Photo,Class,ID_UID,Name,Father_Name,Mother_Name,Gender,Adm_No,DOB,Adm_Date,Status,Aadhaar,Father_Phone,Mother_Phone,Permanent_Address\n";
    const blob = new Blob([csvData], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.setAttribute('hidden', ''); a.setAttribute('href', url); a.setAttribute('download', 'student_upload_template.csv');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
};

const dropZone = document.getElementById('excel-drop-zone'), fileInput = document.getElementById('excel-file-input');
let excelParsedData = [];
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); if(e.dataTransfer.files.length) handleExcelFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', (e) => { if(e.target.files.length) handleExcelFile(e.target.files[0]); });

function normalizeToIsoDate(val) {
    if (val === null || val === undefined || val === '') return '';
    if (val instanceof Date && !isNaN(val.getTime())) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const str = String(val).trim();
    if (!str) return '';

    // 1. Numeric Excel Date Serial (e.g. 43722)
    if (/^\d{4,5}(\.\d+)?$/.test(str)) {
        const num = parseFloat(str);
        if (num > 1000 && num < 100000) {
            const utcDays = Math.floor(num - 25569);
            const date = new Date(utcDays * 86400 * 1000);
            if (!isNaN(date.getTime())) {
                const y = date.getUTCFullYear();
                const m = String(date.getUTCMonth() + 1).padStart(2, '0');
                const d = String(date.getUTCDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            }
        }
    }

    // 2. ISO format: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
    const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
        const y = isoMatch[1];
        const m = isoMatch[2].padStart(2, '0');
        const d = isoMatch[3].padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    // 3. DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (dmyMatch) {
        const d = dmyMatch[1].padStart(2, '0');
        const m = dmyMatch[2].padStart(2, '0');
        const y = dmyMatch[3];
        return `${y}-${m}-${d}`;
    }

    // 4. Fallback Date parse
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1900 && parsed.getFullYear() < 2100) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    return str;
}

function handleExcelFile(file) {
    const selectedBulkClass = (document.getElementById('bulk-upload-class')?.value || '').toUpperCase().trim();
    if(!selectedBulkClass) {
        alert('Please select a target class first.');
        fileInput.value = '';
        return;
    }
    document.getElementById('excel-file-name').textContent = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array', cellDates: true});
            const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {defval: ""});
            if(rawData.length === 0) return alert("File is empty.");

            const normalizeHeader = (value = '') => value.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
            const aliasMap = {
                uid: ['iduid', 'id', 'uid', 'rollno', 'rollnumber'],
                name: ['name', 'studentname', 'student'],
                father: ['fathername', 'father', 'parent', 'fatherguardian', 'guardian'],
                mother: ['mother', 'mothername'],
                gender: ['gender', 'sex'],
                status: ['status', 'state'],
                mobile: ['mobile', 'phone', 'mobileno', 'phonenumber', 'fatherphone', 'fatherphonenumber', 'contact', 'contactno'],
                motherMobile: ['mothermobile', 'motherphone', 'motherphonenumber'],
                adm: ['admno', 'admissionno', 'admissionnumber', 'adm', 'admn', 'admno.'],
                address: ['permanentaddress', 'address', 'permanent', 'addr'],
                dob: ['dob', 'dateofbirth', 'birthdate', 'birth', 'studentdob', 'dobddmmyyyy', 'dateofbirthddmmyyyy'],
                admDate: ['admdate', 'dateofadmission', 'admissiondate', 'admnsdate', 'admldate', 'joiningdate', 'admissiondateddmmyyyy', 'admdateddmmyyyy'],
                adhaar: ['aadhaar', 'adhaar', 'aadharno', 'aadhaarnumber', 'adhaarnumber', 'uidai'],
                samastha: ['samastha', 'samasthaid', 'samasthano', 'regno', 'registrationno']
            };

            // Analyze each row against the 15 standard student fields
            // Standard fields: 1.Photo, 2.Class, 3.UID, 4.Name*, 5.Father, 6.Mother, 7.Gender*, 8.Adm No, 9.DOB, 10.Adm Date, 11.Status, 12.Aadhaar, 13.Father Mobile, 14.Mother Mobile, 15.Address
            const existingClassStudents = students.filter(st => String(st.class || '').toUpperCase().trim() === selectedBulkClass);
            
            // Build lookup for existing class students
            // Match can be on Adm No (if present) OR (Name AND (UID OR Father OR Mobile))
            const findExistingMatch = (candidate) => {
                const candAdm = String(candidate.adm || '').toUpperCase().trim();
                const candName = String(candidate.name || '').toUpperCase().trim();
                const candUid = String(candidate.uid || '').toUpperCase().trim();
                const candMobile = String(candidate.mobile || '').trim();

                return existingClassStudents.find(exist => {
                    const existAdm = String(exist.adm || '').toUpperCase().trim();
                    const existName = String(exist.name || '').toUpperCase().trim();
                    const existUid = String(exist.uid || '').toUpperCase().trim();
                    const existMobile = String(exist.mobile || '').trim();

                    if (candAdm && existAdm && candAdm === existAdm) return true;
                    if (candUid && existUid && candUid === existUid) return true;
                    if (candName && existName && candName === existName) {
                        if (candMobile && existMobile && candMobile === existMobile) return true;
                        if (!candAdm && !existAdm) return true;
                    }
                    return false;
                });
            };

            excelParsedData = rawData.map((row, rowIdx) => {
                const keys = Object.keys(row);
                const getVal = (aliases = []) => {
                    const key = keys.find((col) => {
                        const norm = normalizeHeader(col);
                        return aliases.includes(norm) || aliases.some(a => (norm.startsWith(a) && (norm.includes('date') || norm.includes('dob'))));
                    });
                    return key ? (row[key] !== undefined && row[key] !== null ? row[key] : '') : '';
                };

                const rawName = String(getVal(aliasMap.name) || '').trim();
                const rawDob = getVal(aliasMap.dob);
                const dobVal = normalizeToIsoDate(rawDob);
                const rawAdmDate = getVal(aliasMap.admDate);
                const admDateVal = normalizeToIsoDate(rawAdmDate);
                const adhaarVal = String(getVal(aliasMap.adhaar) || '').trim();
                const samasthaVal = String(getVal(aliasMap.samastha) || '').trim();
                const motherVal = String(getVal(aliasMap.mother) || '').trim();
                const motherMobileVal = String(getVal(aliasMap.motherMobile) || '').trim();
                const admVal = String(getVal(aliasMap.adm) || '').toUpperCase().trim();
                const uidVal = String(getVal(aliasMap.uid) || '').trim();
                const fatherVal = String(getVal(aliasMap.father) || '').toUpperCase().trim();
                const mobileVal = String(getVal(aliasMap.mobile) || '').trim();
                const addressVal = String(getVal(aliasMap.address) || '').trim();
                const statusVal = normalizeStudentStatus(String(getVal(aliasMap.status) || ''));
                const genderRaw = String(getVal(aliasMap.gender) || '').toLowerCase().trim();
                const genderVal = genderRaw.startsWith('f') ? 'Female' : 'Male';

                // Row-level and field-level validation
                const fieldStatuses = {};
                const omittedFields = [];
                const fatalReasons = [];

                // 2. Class (Auto mapped to selected class)
                fieldStatuses.class = { status: 'valid', val: selectedBulkClass };

                // 4. Student Name (Mandatory)
                const hasFatalError = !rawName;
                if (hasFatalError) {
                    fieldStatuses.name = { status: 'error', val: '', reason: 'Name is mandatory' };
                    fatalReasons.push('Missing Student Name');
                } else {
                    fieldStatuses.name = { status: 'valid', val: rawName.toUpperCase().trim() };
                }

                // 7. Gender (Mandatory - defaults to Male if blank)
                if (!genderRaw) {
                    fieldStatuses.gender = { status: 'blank', val: genderVal, note: 'Defaulted to Male' };
                } else {
                    fieldStatuses.gender = { status: 'valid', val: genderVal };
                }

                // 3. UID
                fieldStatuses.uid = uidVal ? { status: 'valid', val: uidVal } : { status: 'blank', val: '' };

                // 5. Father Name
                fieldStatuses.father = fatherVal ? { status: 'valid', val: fatherVal } : { status: 'blank', val: '' };

                // 6. Mother Name
                fieldStatuses.mother = motherVal ? { status: 'valid', val: motherVal.toUpperCase() } : { status: 'blank', val: '' };

                // 8. Adm No
                fieldStatuses.adm = admVal ? { status: 'valid', val: admVal } : { status: 'blank', val: '' };

                // 9. DOB (Optional: invalid format is omitted, does NOT block the student)
                let cleanDob = '';
                if (rawDob) {
                    if (dobVal) {
                        cleanDob = dobVal;
                        fieldStatuses.dob = { status: 'valid', val: cleanDob };
                    } else {
                        fieldStatuses.dob = { status: 'error', val: String(rawDob), reason: 'Invalid date format (will be saved as blank)' };
                        omittedFields.push('Date of Birth');
                    }
                } else {
                    fieldStatuses.dob = { status: 'blank', val: '' };
                }

                // 10. Adm Date (Optional: invalid format is omitted, does NOT block the student)
                let cleanAdmDate = '';
                if (rawAdmDate) {
                    if (admDateVal) {
                        cleanAdmDate = admDateVal;
                        fieldStatuses.admDate = { status: 'valid', val: cleanAdmDate };
                    } else {
                        fieldStatuses.admDate = { status: 'error', val: String(rawAdmDate), reason: 'Invalid date format (will be saved as blank)' };
                        omittedFields.push('Admission Date');
                    }
                } else {
                    fieldStatuses.admDate = { status: 'blank', val: '' };
                }

                // 11. Status
                fieldStatuses.status = { status: 'valid', val: statusVal };

                // 12. Aadhaar (Optional: invalid format is omitted, does NOT block the student)
                let cleanAdhaar = '';
                if (adhaarVal) {
                    const digitsOnly = adhaarVal.replace(/\s+/g, '');
                    if (/^\d{12}$/.test(digitsOnly)) {
                        cleanAdhaar = digitsOnly;
                        fieldStatuses.adhaar = { status: 'valid', val: cleanAdhaar };
                    } else {
                        fieldStatuses.adhaar = { status: 'error', val: adhaarVal, reason: 'Invalid Aadhaar format (must be 12 digits, will be saved as blank)' };
                        omittedFields.push('Aadhaar');
                    }
                } else {
                    fieldStatuses.adhaar = { status: 'blank', val: '' };
                }

                // 13. Father Mobile (Optional: invalid format is omitted, does NOT block the student)
                let cleanMobile = '';
                if (mobileVal) {
                    const sanitizedMobile = mobileVal.replace(/[\s-]/g, '');
                    if (/^\+?\d{7,15}$/.test(sanitizedMobile)) {
                        cleanMobile = sanitizedMobile;
                        fieldStatuses.mobile = { status: 'valid', val: cleanMobile };
                    } else {
                        fieldStatuses.mobile = { status: 'error', val: mobileVal, reason: 'Invalid mobile number (will be saved as blank)' };
                        omittedFields.push('Father Mobile');
                    }
                } else {
                    fieldStatuses.mobile = { status: 'blank', val: '' };
                }

                // 14. Mother Mobile (Optional: invalid format is omitted, does NOT block the student)
                let cleanMotherMobile = '';
                if (motherMobileVal) {
                    const sanitizedMotherMobile = motherMobileVal.replace(/[\s-]/g, '');
                    if (/^\+?\d{7,15}$/.test(sanitizedMotherMobile)) {
                        cleanMotherMobile = sanitizedMotherMobile;
                        fieldStatuses.motherMobile = { status: 'valid', val: cleanMotherMobile };
                    } else {
                        fieldStatuses.motherMobile = { status: 'error', val: motherMobileVal, reason: 'Invalid mobile number (will be saved as blank)' };
                        omittedFields.push('Mother Mobile');
                    }
                } else {
                    fieldStatuses.motherMobile = { status: 'blank', val: '' };
                }

                // 15. Address
                fieldStatuses.address = addressVal ? { status: 'valid', val: addressVal } : { status: 'blank', val: '' };

                const studentObj = {
                    rowIdx: rowIdx + 1,
                    academicYear: activeAcademicYear || currentAcademicYear,
                    name: rawName ? rawName.toUpperCase().trim() : "",
                    class: selectedBulkClass,
                    studentClass: selectedBulkClass,
                    status: statusVal,
                    gender: genderVal,
                    uid: uidVal,
                    father: fatherVal,
                    mother: motherVal.toUpperCase(),
                    mobile: cleanMobile,
                    motherMobile: cleanMotherMobile,
                    adm: admVal,
                    address: addressVal,
                    dob: cleanDob,
                    admDate: cleanAdmDate,
                    adm_date: cleanAdmDate,
                    adhaar: cleanAdhaar,
                    samasthaId: samasthaVal,
                    photo: '',
                    fieldStatuses,
                    omittedFields,
                    hasFatalError,
                    fatalReasons,
                    hasOmittedFields: omittedFields.length > 0,
                    hasErrors: hasFatalError,
                    profile: {
                        dob: cleanDob,
                        address: addressVal,
                        adhaar: cleanAdhaar,
                        admNo: admVal,
                        admDate: cleanAdmDate,
                        adm_date: cleanAdmDate,
                        samasthaId: samasthaVal,
                        photo: '',
                        uid: uidVal,
                        father: fatherVal,
                        mother: motherVal.toUpperCase(),
                        mobile: cleanMobile,
                        motherMobile: cleanMotherMobile,
                        status: statusVal
                    }
                };

                const existingMatch = findExistingMatch(studentObj);
                studentObj.existingMatch = existingMatch || null;
                studentObj.isDuplicate = !!existingMatch;

                return studentObj;
            }).filter(s => s.name || s.hasFatalError); // Keep all records that have name or were explicitly submitted

            // Compute diagnostic summary statistics
            const totalCount = excelParsedData.length;
            const validStudents = excelParsedData.filter(s => !s.hasFatalError);
            const completelyValidStudents = excelParsedData.filter(s => !s.hasFatalError && (s.omittedFields?.length || 0) === 0);
            const fatalRows = excelParsedData.filter(s => s.hasFatalError);
            const validCount = validStudents.length;
            const completelyValidCount = completelyValidStudents.length;
            const fatalCount = fatalRows.length;
            const totalOmittedFields = validStudents.reduce((acc, s) => acc + (s.omittedFields?.length || 0), 0);
            const mergeCount = validStudents.filter(s => s.isDuplicate).length;

            const statTotal = document.getElementById('stat-total-records');
            const statValid = document.getElementById('stat-valid-records');
            const statIssue = document.getElementById('stat-issue-records');
            const statMerge = document.getElementById('stat-merge-records');
            if (statTotal) statTotal.textContent = totalCount;
            if (statValid) statValid.textContent = completelyValidCount;
            if (statIssue) {
                if (fatalCount > 0 && totalOmittedFields > 0) {
                    statIssue.textContent = `${fatalCount} Fatal (${totalOmittedFields} fields skipped)`;
                } else if (fatalCount > 0) {
                    statIssue.textContent = `${fatalCount} Fatal`;
                } else if (totalOmittedFields > 0) {
                    statIssue.textContent = `${totalOmittedFields} fields skipped`;
                } else {
                    statIssue.textContent = '0';
                }
            }
            if (statMerge) statMerge.textContent = mergeCount;

            // Configure action buttons dynamically based on validation results
            const startBtn = document.getElementById('start-upload-btn');
            const startBtnText = document.getElementById('start-upload-btn-text');
            const skipBtn = document.getElementById('skip-issues-upload-btn');
            const validOnlyCountSpan = document.getElementById('valid-only-count');
            const cancelBtn = document.getElementById('cancel-upload-btn');

            if (cancelBtn) cancelBtn.disabled = false;

            if (validCount === 0) {
                if (startBtn) {
                    startBtn.disabled = true;
                    if (startBtnText) startBtnText.textContent = 'Cannot Upload (Missing Names)';
                }
                if (skipBtn) {
                    skipBtn.classList.add('hidden');
                    skipBtn.disabled = true;
                }
            } else {
                if (startBtn) {
                    startBtn.disabled = false;
                    if (startBtnText) {
                        startBtnText.textContent = `Upload All (${validCount})`;
                    }
                }
                if (skipBtn) {
                    // Show "Upload Valid Only" option if there are valid records
                    skipBtn.classList.remove('hidden');
                    if (validOnlyCountSpan) validOnlyCountSpan.textContent = completelyValidCount;
                    skipBtn.disabled = completelyValidCount === 0;
                }
            }

            // Show or hide duplicate policy container
            const dupContainer = document.getElementById('duplicate-policy-container');
            const dupDetectedCount = document.getElementById('duplicate-detected-count');
            if (dupContainer) {
                if (mergeCount > 0) {
                    dupContainer.classList.remove('hidden');
                    if (dupDetectedCount) dupDetectedCount.textContent = mergeCount;
                } else {
                    dupContainer.classList.add('hidden');
                }
            }

            // Render Full Dataset Preview Table with color coding
            const previewContainer = document.getElementById('excel-preview-table-container');
            if (previewContainer) {
                if (excelParsedData.length > 0) {
                    const renderCell = (st, fieldKey, displayVal) => {
                        const statusObj = st.fieldStatuses?.[fieldKey] || { status: 'valid', val: displayVal };
                        let bgClass = '';
                        let titleAttr = '';
                        
                        if (statusObj.status === 'error') {
                            bgClass = 'bg-rose-50 text-rose-900 border-rose-200';
                            titleAttr = `title="${statusObj.reason || 'Invalid data - will be omitted'}"`;
                        } else if (statusObj.status === 'blank') {
                            bgClass = 'bg-amber-50 text-amber-800 italic';
                            titleAttr = 'title="Blank / Not provided"';
                        }
                        
                        let display = '';
                        if (statusObj.status === 'error') {
                            const rawVal = (statusObj.val !== undefined && statusObj.val !== null && String(statusObj.val).trim() !== '')
                                ? String(statusObj.val).trim()
                                : (displayVal !== undefined && displayVal !== null ? String(displayVal).trim() : '');
                            
                            if (rawVal) {
                                display = `<span class="text-rose-600 font-semibold">${escapeHtml(rawVal)}</span>`;
                            } else {
                                display = '<span class="text-rose-600 font-bold italic">Missing *</span>';
                            }
                        } else if (statusObj.status === 'blank' || (!displayVal && !statusObj.val)) {
                            display = '<span class="text-amber-500 font-normal">--</span>';
                        } else {
                            const valToShow = (statusObj.val !== undefined && statusObj.val !== null && statusObj.val !== '') 
                                ? statusObj.val 
                                : displayVal;
                            display = escapeHtml(String(valToShow));
                        }
                        return `<td class="p-2 border-b border-r border-slate-100 whitespace-nowrap ${bgClass}" ${titleAttr}>${display}</td>`;
                    };

                    previewContainer.innerHTML = `
                        <div class="px-3 py-2 bg-slate-100/80 border-b border-slate-200 text-xs font-semibold text-slate-800 flex flex-wrap justify-between items-center gap-2">
                            <span class="flex items-center gap-2">
                                <i class="fas fa-table-list text-slate-600"></i>
                                <span>Complete File Preview (All ${excelParsedData.length} records)</span>
                            </span>
                            <span class="text-xs text-slate-500 font-normal">
                                Scroll horizontally & vertically to inspect all 15 fields
                            </span>
                        </div>
                        <div class="overflow-x-auto max-h-[380px] overflow-y-auto">
                            <table class="w-full text-xs text-left text-slate-700 border-collapse">
                                <thead class="bg-slate-100 text-slate-700 font-bold uppercase sticky top-0 z-10 shadow-sm border-b border-slate-300">
                                    <tr>
                                        <th class="p-2 border-b border-r bg-slate-100 text-center w-10">#</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Status</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Name *</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Adm No</th>
                                        <th class="p-2 border-b border-r bg-slate-100">DOB</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Adm Date</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Gender *</th>
                                        <th class="p-2 border-b border-r bg-slate-100">ID/UID</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Father's Name</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Mother's Name</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Father Phone</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Mother Phone</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Aadhaar</th>
                                        <th class="p-2 border-b border-r bg-slate-100">Address</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100">
                                    ${excelParsedData.map((s, idx) => {
                                        let rowBg = 'hover:bg-slate-50';
                                        let statusBadge = '';
                                        
                                        if (s.hasFatalError) {
                                            rowBg = 'bg-rose-50/50 hover:bg-rose-100/50';
                                            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-200 text-rose-800" title="Missing student name - cannot be imported">FATAL</span>`;
                                        } else if (s.hasOmittedFields) {
                                            rowBg = 'bg-amber-50/30 hover:bg-amber-50/60';
                                            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-200" title="Valid student (${s.omittedFields.length} invalid field(s) skipped: ${s.omittedFields.join(', ')})">READY (${s.omittedFields.length} SKIPPED)</span>`;
                                        } else if (s.isDuplicate) {
                                            rowBg = 'bg-sky-50/50 hover:bg-sky-100/50';
                                            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-200 text-sky-800" title="Matches existing student in this class">EXISTING</span>`;
                                        } else {
                                            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">READY</span>`;
                                        }

                                        return `
                                            <tr class="${rowBg}">
                                                <td class="p-2 text-center text-slate-400 border-b border-r border-slate-100 font-mono">${idx + 1}</td>
                                                <td class="p-2 border-b border-r border-slate-100 whitespace-nowrap">${statusBadge}</td>
                                                ${renderCell(s, 'name', s.name)}
                                                ${renderCell(s, 'adm', s.adm)}
                                                ${renderCell(s, 'dob', s.dob)}
                                                ${renderCell(s, 'admDate', s.admDate)}
                                                ${renderCell(s, 'gender', s.gender)}
                                                ${renderCell(s, 'uid', s.uid)}
                                                ${renderCell(s, 'father', s.father)}
                                                ${renderCell(s, 'mother', s.mother)}
                                                ${renderCell(s, 'mobile', s.mobile)}
                                                ${renderCell(s, 'motherMobile', s.motherMobile)}
                                                ${renderCell(s, 'adhaar', s.adhaar)}
                                                ${renderCell(s, 'address', s.address)}
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    `;
                    previewContainer.classList.remove('hidden');
                } else {
                    previewContainer.innerHTML = '';
                    previewContainer.classList.add('hidden');
                }
            }

            document.getElementById('excel-drop-zone').classList.add('hidden');
            document.getElementById('excel-preview-area').classList.remove('hidden');
            document.getElementById('upload-progress-bar').classList.add('hidden');
            document.getElementById('upload-status-text').textContent = "Ready to upload";
        } catch(err) { 
            console.error("Error parsing Excel file:", err); 
            alert("Error reading file: " + (err.message || err)); 
        }
    };
    reader.readAsArrayBuffer(file);
}

document.getElementById('cancel-upload-btn').addEventListener('click', () => {
    fileInput.value = '';
    excelParsedData = [];
    const previewContainer = document.getElementById('excel-preview-table-container');
    if (previewContainer) {
        previewContainer.innerHTML = '';
        previewContainer.classList.add('hidden');
    }
    const dupContainer = document.getElementById('duplicate-policy-container');
    if (dupContainer) dupContainer.classList.add('hidden');
    const skipBtn = document.getElementById('skip-issues-upload-btn');
    if (skipBtn) skipBtn.classList.add('hidden');
    const startBtn = document.getElementById('start-upload-btn');
    const startBtnText = document.getElementById('start-upload-btn-text');
    if (startBtn) startBtn.disabled = false;
    if (startBtnText) startBtnText.textContent = 'Upload All';
    document.getElementById('upload-progress-bar').classList.add('hidden');
    document.getElementById('excel-drop-zone').classList.remove('hidden');
    document.getElementById('excel-preview-area').classList.add('hidden');
});

// Common execution function for bulk import / merge
async function executeBulkImport(datasetToUpload, mergePolicy) {
    if (!requirePermission('students.manage')) return;
    if (!datasetToUpload || !datasetToUpload.length) {
        return alert('No student records selected for upload.');
    }
    const selectedBulkClass = (document.getElementById('bulk-upload-class')?.value || '').toUpperCase().trim();
    if (!selectedBulkClass) return alert('Please select a target class.');

    const startBtn = document.getElementById('start-upload-btn');
    const skipBtn = document.getElementById('skip-issues-upload-btn');
    const cancelBtn = document.getElementById('cancel-upload-btn');
    const bar = document.getElementById('upload-progress-bar');
    const fill = document.getElementById('upload-progress-fill');
    const status = document.getElementById('upload-status-text');

    startBtn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    cancelBtn.disabled = true;
    bar.classList.remove('hidden');

    let addedCount = 0;
    let mergedCount = 0;
    let skippedCount = 0;

    try {
        for (let i = 0; i < datasetToUpload.length; i += 50) {
            const chunk = datasetToUpload.slice(i, i + 50);
            const batch = writeBatch(db);

            chunk.forEach((s) => {
                const cleanPayload = {
                    name: s.name,
                    class: s.class,
                    studentClass: s.studentClass,
                    status: s.status || 'Active',
                    gender: s.gender || 'Male',
                    uid: s.uid || '',
                    father: s.father || '',
                    mother: s.mother || '',
                    mobile: s.mobile || '',
                    motherMobile: s.motherMobile || '',
                    adm: s.adm || '',
                    address: s.address || '',
                    dob: s.dob || '',
                    admDate: s.admDate || '',
                    adm_date: s.admDate || '',
                    adhaar: s.adhaar || '',
                    samasthaId: s.samasthaId || '',
                    photo: s.photo || '',
                    academicYear: s.academicYear || activeAcademicYear || currentAcademicYear,
                    profile: {
                        dob: s.dob || '',
                        address: s.address || '',
                        adhaar: s.adhaar || '',
                        admNo: s.adm || '',
                        admDate: s.admDate || '',
                        adm_date: s.admDate || '',
                        samasthaId: s.samasthaId || '',
                        photo: s.photo || '',
                        uid: s.uid || '',
                        father: s.father || '',
                        mother: s.mother || '',
                        mobile: s.mobile || '',
                        motherMobile: s.motherMobile || '',
                        status: s.status || 'Active'
                    }
                };

                if (s.isDuplicate && s.existingMatch) {
                    if (mergePolicy === 'merge') {
                        // Merge fields into existing student document
                        const existingDocId = s.existingMatch.id;
                        const studentRef = doc(db, `${BASE_PATH}/students`, existingDocId);
                        
                        // Pick non-empty new values to merge into profile and root
                        const updateData = {};
                        ['name', 'gender', 'adm', 'dob', 'admDate', 'uid', 'father', 'mother', 'mobile', 'motherMobile', 'address', 'adhaar', 'status'].forEach(f => {
                            if (cleanPayload[f]) {
                                updateData[f] = cleanPayload[f];
                                updateData[`profile.${f}`] = cleanPayload[f];
                            }
                        });
                        batch.set(studentRef, updateData, { merge: true });
                        batch.set(getEnrollmentRef(cleanPayload.academicYear, existingDocId), buildEnrollmentPayload(existingDocId, { ...s.existingMatch, ...cleanPayload }), { merge: true });
                        mergedCount += 1;
                    } else {
                        // Skip existing
                        skippedCount += 1;
                    }
                } else {
                    // Create new student document
                    const studentRef = doc(collection(db, `${BASE_PATH}/students`));
                    batch.set(studentRef, cleanPayload);
                    batch.set(getEnrollmentRef(cleanPayload.academicYear, studentRef.id), buildEnrollmentPayload(studentRef.id, cleanPayload), { merge: true });
                    addedCount += 1;
                }
            });

            await batch.commit();
            const processedSoFar = Math.min(i + chunk.length, datasetToUpload.length);
            fill.style.width = `${(processedSoFar / datasetToUpload.length) * 100}%`;
            status.textContent = `Processing ${processedSoFar} of ${datasetToUpload.length} students...`;
        }

        await syncActiveAcademicYearClasses([selectedBulkClass]);
        await logAuditEvent({
            category: 'student',
            action: 'student.import',
            entityType: 'student',
            message: `Bulk import processed ${datasetToUpload.length} students: ${addedCount} added, ${mergedCount} merged, ${skippedCount} skipped existing.`,
            metadata: { addedCount, mergedCount, skippedCount, targetClass: selectedBulkClass }
        });

        status.innerHTML = `<span class="text-emerald-600 font-bold">✔ Completed: ${addedCount} added, ${mergedCount} merged${skippedCount ? `, ${skippedCount} skipped` : ''}!</span>`;
        alert(`Bulk upload completed!\n\n• Newly Added: ${addedCount}\n• Merged / Updated: ${mergedCount}\n• Skipped (Duplicates): ${skippedCount}`);
        cancelBtn.disabled = false;
        cancelBtn.click();
    } catch (err) {
        console.error("Bulk upload error:", err);
        status.innerHTML = `<span class="text-rose-600 font-bold">Error uploading students: ${err.message}</span>`;
        alert("Upload error: " + err.message);
    } finally {
        startBtn.disabled = false;
        if (skipBtn) skipBtn.disabled = false;
        cancelBtn.disabled = false;
    }
}

// Upload All Click (Uploads all students with valid names, automatically omitting invalid optional fields)
document.getElementById('start-upload-btn').addEventListener('click', async () => {
    if (!excelParsedData || excelParsedData.length === 0) return;
    const validRows = excelParsedData.filter(s => !s.hasFatalError);
    const fatalRows = excelParsedData.filter(s => s.hasFatalError);
    const mergePolicy = document.querySelector('input[name="dup-action-policy"]:checked')?.value || 'skip';

    if (!validRows.length) {
        alert("Cannot upload: All rows are missing mandatory student names.");
        return;
    }

    const selectedBulkClass = (document.getElementById('bulk-upload-class')?.value || '').toUpperCase().trim();
    const totalOmitted = validRows.reduce((acc, s) => acc + (s.omittedFields?.length || 0), 0);

    let confirmMsg = `Upload all ${validRows.length} student(s) to Class ${selectedBulkClass}?`;
    if (totalOmitted > 0) {
        confirmMsg += `\n\n• Note: ${totalOmitted} invalid optional field(s) across these students will be omitted (saved as blank).`;
    }
    if (fatalRows.length > 0) {
        confirmMsg += `\n\n• Warning: ${fatalRows.length} row(s) missing mandatory student names will be skipped.`;
    }

    if (!confirm(confirmMsg)) return;
    await executeBulkImport(validRows, mergePolicy);
});

// Upload Valid Only Click (Uploads only completely valid students who have zero fatal errors and zero field errors)
document.getElementById('skip-issues-upload-btn')?.addEventListener('click', async () => {
    if (!excelParsedData || excelParsedData.length === 0) return;
    const completelyValidRows = excelParsedData.filter(s => !s.hasFatalError && (s.omittedFields?.length || 0) === 0);
    const invalidCount = excelParsedData.length - completelyValidRows.length;

    if (!completelyValidRows.length) {
        return alert('No completely valid student records without errors found.\n\nYou can use "Upload All" to upload students while skipping invalid optional fields.');
    }
    const mergePolicy = document.querySelector('input[name="dup-action-policy"]:checked')?.value || 'skip';
    const selectedBulkClass = (document.getElementById('bulk-upload-class')?.value || '').toUpperCase().trim();
    
    let confirmMsg = `Upload ${completelyValidRows.length} completely valid student(s) to Class ${selectedBulkClass}?`;
    if (invalidCount > 0) {
        confirmMsg += `\n\n• Note: ${invalidCount} record(s) containing errors or missing data will be skipped.`;
    }

    if (!confirm(confirmMsg)) return;
    await executeBulkImport(completelyValidRows, mergePolicy);
});

document.getElementById('add-manual-btn')?.addEventListener('click', async () => {
    if(!requirePermission('students.manage')) return;
    const btn = document.getElementById('add-manual-btn');
    const cls = (document.getElementById('add-stu-class')?.value || '').toUpperCase().trim();
    const name = (document.getElementById('add-stu-name')?.value || '').toUpperCase().trim();
    const gender = document.getElementById('add-stu-gender')?.value || 'Male';
    if(!cls || !name || !gender) return alert("Class, Name and Gender are mandatory.");
    if(!confirm("Are you sure you want to add this student?")) return;

    try {
        if (btn) btn.disabled = true;

        const photoVal = document.getElementById('add-stu-photo')?.value?.trim() || '';
        const dobVal = document.getElementById('add-stu-dob')?.value || '';
        const admDateVal = document.getElementById('add-stu-adm-date')?.value || '';
        const adhaarVal = document.getElementById('add-stu-adhaar')?.value?.trim() || '';
        const samasthaVal = document.getElementById('add-stu-samastha')?.value?.trim() || '';
        const uidVal = document.getElementById('add-stu-uid')?.value?.trim() || '';
        const admVal = (document.getElementById('add-stu-adm')?.value || '').toUpperCase().trim();
        const mobileVal = document.getElementById('add-stu-mobile')?.value?.trim() || '';
        const fatherVal = (document.getElementById('add-stu-father')?.value || '').toUpperCase().trim();
        const motherVal = (document.getElementById('add-stu-mother')?.value || '').toUpperCase().trim();
        const motherMobileVal = document.getElementById('add-stu-mother-mobile')?.value?.trim() || '';
        const addressVal = document.getElementById('add-stu-address')?.value?.trim() || '';
        const statusVal = normalizeStudentStatus(document.getElementById('add-stu-status')?.value || 'Active');

        const studentActiveYear = activeAcademicYear || currentAcademicYear;
        const nextStudent = {
            academicYear: studentActiveYear,
            class: cls,
            studentClass: cls, // Save both for compatibility with React
            name: name,
            gender: gender,
            status: statusVal,
            academicYears: {
                [studentActiveYear]: {
                    class: cls,
                    status: statusVal,
                    updatedAt: new Date().toISOString()
                }
            },
            uid: uidVal,
            adm: admVal,
            mobile: mobileVal,
            father: fatherVal,
            mother: motherVal,
            motherMobile: motherMobileVal,
            address: addressVal,
            dob: dobVal,
            admDate: admDateVal,
            adm_date: admDateVal,
            adhaar: adhaarVal,
            samasthaId: samasthaVal,
            photo: photoVal,
            profile: {
                dob: dobVal,
                address: addressVal,
                adhaar: adhaarVal,
                admNo: admVal,
                admDate: admDateVal,
                adm_date: admDateVal,
                samasthaId: samasthaVal,
                photo: photoVal,
                uid: uidVal,
                father: fatherVal,
                mother: motherVal,
                mobile: mobileVal,
                motherMobile: motherMobileVal,
                status: statusVal
            }
        };

        const duplicateStudent = students.find((student) => student.class === cls && student.name === name && (student.adm || '') === nextStudent.adm && (student.uid || '') === nextStudent.uid);
        if (duplicateStudent) {
            alert('A matching student already exists in this academic year.');
            if (btn) btn.disabled = false;
            return;
        }

        const studentDoc = await addDoc(collection(db, `${BASE_PATH}/students`), nextStudent);
        await syncEnrollmentRecord(studentDoc.id, nextStudent);
        await setDoc(doc(db, `${BASE_PATH}/studentPhotoSubmissions`, studentDoc.id), { photo: photoVal, updatedAt: Date.now() }, { merge: true });
        await syncActiveAcademicYearClasses([cls]);
        await logAuditEvent({ category: 'student', action: 'student.create', entityType: 'student', entityId: studentDoc.id, message: `Student added: ${name}.` });
        
        alert("Student Added!");

        ['add-stu-class','add-stu-uid','add-stu-name','add-stu-father','add-stu-mother','add-stu-mobile','add-stu-mother-mobile','add-stu-adm','add-stu-address','add-stu-photo', 'add-stu-dob', 'add-stu-adm-date', 'add-stu-adhaar', 'add-stu-samastha'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        updateAdminPhotoWidgetPreview('', 'add-stu-photo-preview', 'add-stu-photo-placeholder', 'add-stu-remove-btn', 'add-stu-photo');
        const statusEl = document.getElementById('add-stu-status');
        if (statusEl) statusEl.value = 'Active';
    } catch(err) {
        console.error("Failed to add student:", err);
        alert("Failed to add student: " + (err.message || err));
    } finally {
        if (btn) btn.disabled = false;
    }
});

const saveStudentPortalPermissions = async () => {
    if (!requirePermission('students.manage')) return;
    const photoUploadChecked = document.getElementById('admin-toggle-student-photo-upload')?.checked || false;
    const detailsEditChecked = document.getElementById('admin-toggle-student-details-edit')?.checked || false;
    const msg = document.getElementById('student-permissions-status-msg');

    try {
        await setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {
            allowStudentPhotoUpload: photoUploadChecked,
            allowStudentDetailsEdit: detailsEditChecked
        }, { merge: true });
        if (msg) {
            msg.classList.remove('hidden');
            setTimeout(() => msg.classList.add('hidden'), 2500);
        }
    } catch (err) {
        console.error('Failed to update student portal permissions:', err);
        alert('Unable to save permissions: ' + err.message);
    }
};

document.getElementById('admin-toggle-student-photo-upload')?.addEventListener('change', saveStudentPortalPermissions);
document.getElementById('admin-toggle-student-details-edit')?.addEventListener('change', saveStudentPortalPermissions);


// --- 3. MANAGE STUDENTS ---
const populateClassDropdowns = () => {
    classes = getClassesForActiveYear();
    const opts = classes.map(c => `<option value="${c}">${c}</option>`).join('');
    const dataList = document.getElementById('class-suggestions');
    if (dataList) dataList.innerHTML = opts;

    const filterManage = document.getElementById('filter-manage-class'); const prevManageVal = filterManage.value;
    filterManage.innerHTML = `<option value="all">All Classes</option>` + opts + `<option value="ALUMNI">Alumni</option>`;
    if(prevManageVal === 'all' || prevManageVal === 'ALUMNI' || prevManageVal === 'GRADUATED' || classes.includes(prevManageVal)) {
        filterManage.value = (prevManageVal === 'GRADUATED') ? 'ALUMNI' : prevManageVal;
    }

    const filterConc = document.getElementById('filter-conc-class'); const prevConcVal = filterConc.value;
    filterConc.innerHTML = `<option value="">-- All Classes / Select --</option>` + opts; if(classes.includes(prevConcVal)) filterConc.value = prevConcVal;

    const activeConcClassFilter = document.getElementById('active-conc-class-filter');
    if (activeConcClassFilter) {
        const prevActVal = activeConcClassFilter.value;
        activeConcClassFilter.innerHTML = `<option value="all">All Classes</option>` + opts;
        if (prevActVal === 'all' || classes.includes(prevActVal)) activeConcClassFilter.value = prevActVal;
    }
    const bulkClassSel = document.getElementById('bulk-upload-class');
    if (bulkClassSel) {
        const prevBulkClass = bulkClassSel.value;
        bulkClassSel.innerHTML = `<option value="">-- Select Class --</option>` + opts;
        if (classes.includes(prevBulkClass)) bulkClassSel.value = prevBulkClass;
    }
};

const populateManageAcademicYearDropdown = (forceActive = false) => {
    const yearSelect = document.getElementById('filter-manage-academic-year');
    if (!yearSelect) return;
    const currentSelected = forceActive ? getActiveAcademicYearLabel() : (yearSelect.value || getActiveAcademicYearLabel());
    const sortedYears = [...academicYears].sort((a, b) => (b.startYear || 0) - (a.startYear || 0));

    if (sortedYears.length === 0) {
        yearSelect.innerHTML = `<option value="${escapeHtml(getActiveAcademicYearLabel())}">${escapeHtml(getActiveAcademicYearLabel())} (Current)</option>`;
        yearSelect.value = getActiveAcademicYearLabel();
        return;
    }

    yearSelect.innerHTML = sortedYears.map((y) => {
        const isCurrent = y.label === activeAcademicYear;
        const isArchived = y.status === 'archived';
        const tag = isCurrent ? ' (Current)' : (isArchived ? ' (Archive)' : ' (Active)');
        return `<option value="${escapeHtml(y.label)}">${escapeHtml(y.label)}${tag}</option>`;
    }).join('');

    if (!forceActive && sortedYears.some((y) => y.label === currentSelected)) {
        yearSelect.value = currentSelected;
    } else {
        yearSelect.value = getActiveAcademicYearLabel();
    }
};

const openStudentHistoryModal = (studentId) => {
    const student = rawStudents.find(s => s.id === studentId);
    if (!student) return alert('Student not found.');
    
    const summaryContainer = document.getElementById('student-history-profile-summary');
    const timelineContainer = document.getElementById('student-history-timeline-container');
    const popup = document.getElementById('student-history-popup');
    if (!summaryContainer || !timelineContainer || !popup) return;

    const stuPhoto = student.photo || student.profile?.photo || '';
    const prof = student.profile || {};
    const currentClass = student.class || student.studentClass || prof.class || '--';
    const status = normalizeStudentStatus(student.status || prof.status);

    summaryContainer.innerHTML = `
        <div class="w-16 h-16 rounded-full overflow-hidden bg-white border-2 border-slate-200 flex items-center justify-center shrink-0 shadow-sm">
            ${stuPhoto ? `<img src="${stuPhoto}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-slate-400 text-2xl"></i>`}
        </div>
        <div class="flex-1 text-center sm:text-left">
            <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                <h4 class="text-lg font-black text-gray-900">${escapeHtml(student.name || '--')}</h4>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold border ${getStudentStatusBadgeClass(status)}">${escapeHtml(status)}</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-gray-600 mt-2">
                <div><span class="text-gray-400 block font-bold">Adm. No:</span> <span class="font-mono font-bold">${escapeHtml(student.adm || prof.admNo || '-')}</span></div>
                <div><span class="text-gray-400 block font-bold">Current Class:</span> <span class="font-bold text-indigo-700">${escapeHtml(currentClass)}</span></div>
                <div><span class="text-gray-400 block font-bold">Gender:</span> <span>${escapeHtml(student.gender || prof.gender || '-')}</span></div>
                <div><span class="text-gray-400 block font-bold">Mobile:</span> <span>${escapeHtml(student.mobile || prof.mobile || '-')}</span></div>
            </div>
        </div>
    `;

    const historyMap = student.academicYears || {};
    const recordedYears = Object.keys(historyMap);

    const entries = [];
    if (recordedYears.length === 0) {
        entries.push({
            yearLabel: student.academicYear || currentAcademicYear,
            class: currentClass,
            status: status,
            updatedAt: student.updatedAt || null
        });
    } else {
        recordedYears.forEach(yearLabel => {
            const entry = historyMap[yearLabel] || {};
            entries.push({
                yearLabel,
                class: entry.class || currentClass,
                status: entry.status || 'Active',
                decision: entry.decision || null,
                updatedAt: entry.updatedAt || null
            });
        });
    }

    entries.sort((a, b) => b.yearLabel.localeCompare(a.yearLabel));

    timelineContainer.innerHTML = entries.map((entry) => {
        const isCurrent = entry.yearLabel === getActiveAcademicYearLabel();
        const entryStatus = normalizeStudentStatus(entry.status);
        const formattedDate = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Recorded';

        return `
            <div class="p-3.5 rounded-xl border ${isCurrent ? 'border-indigo-200 bg-indigo-50/50' : 'border-gray-200 bg-white'} shadow-2xs transition">
                <div class="flex items-center justify-between flex-wrap gap-2">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-black text-gray-900">${escapeHtml(entry.yearLabel)}</span>
                        ${isCurrent ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">Current Session</span>' : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-600">Past Session</span>'}
                    </div>
                    <div class="text-[11px] text-gray-400 font-medium">${escapeHtml(formattedDate)}</div>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2 pt-2 border-t border-gray-100 text-xs">
                    <div>
                        <span class="text-gray-500 block text-[10px] font-bold uppercase">Class in that year:</span>
                        <span class="font-extrabold text-gray-900 text-sm">${escapeHtml(entry.class || '--')}</span>
                    </div>
                    <div>
                        <span class="text-gray-500 block text-[10px] font-bold uppercase">Year Status:</span>
                        <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-bold border mt-0.5 ${getStudentStatusBadgeClass(entryStatus)}">${escapeHtml(entryStatus)}</span>
                    </div>
                    <div>
                        <span class="text-gray-500 block text-[10px] font-bold uppercase">Progression:</span>
                        <span class="text-xs font-semibold text-gray-700">${entry.decision ? escapeHtml(entry.decision.toUpperCase()) : 'Enrolled'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    popup.classList.remove('hidden');
    popup.classList.add('flex');
};

document.getElementById('student-history-close-btn')?.addEventListener('click', () => {
    document.getElementById('student-history-popup')?.classList.add('hidden');
    document.getElementById('student-history-popup')?.classList.remove('flex');
});
document.getElementById('student-history-done-btn')?.addEventListener('click', () => {
    document.getElementById('student-history-popup')?.classList.add('hidden');
    document.getElementById('student-history-popup')?.classList.remove('flex');
});

const renderStudentList = () => {
    const selectedYear = document.getElementById('filter-manage-academic-year')?.value || getActiveAcademicYearLabel();
    const isActiveYear = selectedYear === getActiveAcademicYearLabel();

    const fCls = document.getElementById('filter-manage-class').value;
    const fGen = document.getElementById('filter-manage-gender').value;
    const fStatus = document.getElementById('filter-manage-status').value;
    const sortType = document.getElementById('sort-manage-students').value;
    const sTerm = document.getElementById('search-student-input').value.toLowerCase();
    const cont = document.getElementById('student-list-container');
    const emptyState = document.getElementById('student-list-empty-state');
    const archiveBanner = document.getElementById('historical-archive-banner');
    const archiveYearLabel = document.getElementById('historical-archive-year-label');
    const yearBadge = document.getElementById('manage-students-year-badge');

    if (yearBadge) {
        yearBadge.textContent = `Academic Year: ${selectedYear} ${isActiveYear ? '(Current & Editable)' : '(Historical Archive - Read Only)'}`;
        yearBadge.className = `text-xs font-bold uppercase tracking-widest mt-1 ${isActiveYear ? 'text-indigo-600' : 'text-amber-700'}`;
    }

    if (archiveBanner) {
        if (!isActiveYear) {
            archiveBanner.classList.remove('hidden');
            if (archiveYearLabel) archiveYearLabel.textContent = selectedYear;
        } else {
            archiveBanner.classList.add('hidden');
        }
    }

    emptyState.classList.add('hidden'); cont.classList.remove('hidden');

    const yearStudents = getStudentsForYear(selectedYear);

    const fil = yearStudents.filter(s => {
        let match = true;
        if(fCls !== 'all') {
            if (fCls === 'ALUMNI' || fCls === 'GRADUATED') match = match && (normalizeStudentStatus(s.status) === 'Alumni' || String(s.class || '').toUpperCase() === 'ALUMNI' || String(s.class || '').toUpperCase() === 'GRADUATED');
            else match = match && s.class === fCls;
        }
        if(fGen !== 'all') match = match && s.gender === fGen;
        if(fStatus !== 'all') {
            match = match && normalizeStudentStatus(s.status) === fStatus;
        } else {
            match = match && normalizeStudentStatus(s.status) !== 'Discontinued';
        }
        if(sTerm) match = match && ((s.name && s.name.toLowerCase().includes(sTerm)) || (s.adm && String(s.adm).toLowerCase().includes(sTerm)));
        return match;
    });

    if(fil.length === 0) { cont.innerHTML = '<p class="text-gray-500 p-4 text-center font-medium">No students found.</p>'; return; }

    const compareByAdmission = (a, b) => {
        const admA = a.adm ? a.adm.toString().trim() : ""; const admB = b.adm ? b.adm.toString().trim() : "";
        if (admA === "" && admB === "") return (a.name || '').localeCompare(b.name || '');
        if (admA === "") return 1; if (admB === "") return -1;
        const numA = parseFloat(admA); const numB = parseFloat(admB);
        if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
        return admA.localeCompare(admB, undefined, {numeric: true});
    };
    if (sortType === 'male-first') {
        fil.sort((a, b) => {
            const genderOrder = (a.gender === 'Male' ? 0 : 1) - (b.gender === 'Male' ? 0 : 1);
            if (genderOrder !== 0) return genderOrder;
            return compareByAdmission(a, b);
        });
    } else if (sortType === 'name-asc') {
        fil.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else {
        fil.sort(compareByAdmission);
    }

    let html = `
    <table class="w-full text-sm text-left whitespace-nowrap">
        <thead class="table-header">
            <tr><th class="p-3 w-16 text-center">Sl. No</th><th class="p-3 w-16">Photo</th><th class="p-3">Adm.No</th><th class="p-3">Name</th><th class="p-3">Class, Gender & Status</th><th class="p-3">Mobile</th><th class="p-3 text-right">Actions</th></tr>
        </thead><tbody class="divide-y divide-gray-200">`;

    fil.forEach((s, i) => {
        const status = normalizeStudentStatus(s.status);
        const stuPhoto = s.photo || s.profile?.photo || '';
        let actionButtons = '';

        if (!isActiveYear) {
            actionButtons = `
                <button class="view-student-history-btn bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-3 py-1.5 rounded-md text-xs font-bold transition flex items-center gap-1.5 ml-auto" data-id="${s.id}">
                    <i class="fas fa-history"></i> History
                </button>
            `;
        } else {
            actionButtons = `
                <button class="view-student-history-btn bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-2.5 py-1.5 rounded-md mr-1.5 text-xs font-bold transition" data-id="${s.id}" title="Academic History"><i class="fas fa-history"></i></button>
                <button class="edit-student-btn bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md mr-1.5 text-xs font-bold transition" data-id="${s.id}"><i class="fas fa-edit"></i> Edit</button>
                <button class="delete-student-btn bg-red-50 text-red-600 hover:bg-red-100 px-2.5 py-1.5 rounded-md text-xs font-bold transition" data-id="${s.id}"><i class="fas fa-trash"></i></button>
            `;
        }

        html += `
        <tr class="hover:bg-gray-50 bg-white">
            <td class="p-3 text-center font-bold text-gray-400">${i + 1}</td>
            <td class="p-3">
                <div class="w-10 h-10 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 shadow-inner">
                    ${stuPhoto ? `<img src="${stuPhoto}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-slate-400 text-sm"></i>`}
                </div>
            </td>
            <td class="p-3 font-mono text-gray-500 font-medium">${escapeHtml(s.adm || '-')}</td>
            <td class="p-3 font-bold text-gray-900">${escapeHtml(s.name || '-')}</td>
            <td class="p-3 text-gray-600"><div>${escapeHtml(s.class || '--')} (${escapeHtml(s.gender || '--')})</div><div class="mt-1 inline-flex px-2 py-0.5 rounded-full border text-xs font-bold ${getStudentStatusBadgeClass(status)}">${escapeHtml(status)}</div></td>
            <td class="p-3 text-gray-500">${escapeHtml(s.mobile || '-')}</td>
            <td class="p-3 text-right">
                ${actionButtons}
            </td>
        </tr>`;
    });
    cont.innerHTML = html + `</tbody></table>`;
};
document.getElementById('filter-manage-academic-year')?.addEventListener('change', () => {
    const selectedYear = document.getElementById('filter-manage-academic-year')?.value || getActiveAcademicYearLabel();
    const yearClasses = getClassesForYear(selectedYear);
    const opts = yearClasses.map(c => `<option value="${c}">${c}</option>`).join('');
    const filterManage = document.getElementById('filter-manage-class');
    if (filterManage) {
        const prev = filterManage.value;
        filterManage.innerHTML = `<option value="all">All Classes</option>` + opts + `<option value="ALUMNI">Alumni</option>`;
        if (prev === 'all' || prev === 'ALUMNI' || prev === 'GRADUATED' || yearClasses.includes(prev)) {
            filterManage.value = (prev === 'GRADUATED') ? 'ALUMNI' : prev;
        }
    }
    renderStudentList();
});
document.getElementById('filter-manage-class').addEventListener('change', renderStudentList);
document.getElementById('filter-manage-gender').addEventListener('change', renderStudentList);
document.getElementById('filter-manage-status').addEventListener('change', renderStudentList);
document.getElementById('search-student-input').addEventListener('input', renderStudentList);
document.getElementById('sort-manage-students').addEventListener('change', renderStudentList);

document.getElementById('student-list-container').addEventListener('click', e => {
    const histBtn = e.target.closest('.view-student-history-btn');
    if(histBtn) {
        openStudentHistoryModal(histBtn.dataset.id);
        return;
    }
    const delBtn = e.target.closest('.delete-student-btn'), editBtn = e.target.closest('.edit-student-btn');
    if(delBtn) {
        if(!confirm("Are you sure you want to permanently delete this student and all linked records?")) return;
        deleteStudentsAndDependencies([delBtn.dataset.id]).then(() => logAuditEvent({ category: 'student', action: 'student.delete', entityType: 'student', entityId: delBtn.dataset.id, message: 'Student record deleted with linked cleanup.' })).catch((error) => {
            console.error('Failed to delete student dependencies.', error);
            alert('Failed to delete the student completely. Please try again.');
        });
    }
    if(editBtn) {
        openEditStudentModal(editBtn.dataset.id);
    }
});

const openEditStudentModal = (studentId) => {
    if(!requirePermission('students.manage')) return;
    const st = (rawStudents || []).find(s => s.id === studentId) || (students || []).find(s => s.id === studentId);
    if(st) {
        editingStudentId = st.id;
        const prof = st.profile || {};
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val !== undefined && val !== null ? val : ''; };
        setVal('e-stu-class', st.class || st.studentClass || prof.class || '');
        setVal('e-stu-gender', st.gender || prof.gender || 'Male');
        setVal('e-stu-name', st.name || prof.name || '');
        setVal('e-stu-adm', st.adm || prof.admNo || prof.adm || '');
        setVal('e-stu-mob', st.mobile || prof.mobile || '');
        setVal('e-stu-fat', st.father || prof.father || '');
        setVal('e-stu-mother', st.mother || prof.mother || '');
        setVal('e-stu-mother-mobile', st.motherMobile || prof.motherMobile || '');
        setVal('e-stu-uid', st.uid || prof.uid || '');
        setVal('e-stu-addr', st.address || prof.address || '');
        setVal('e-stu-status', normalizeStudentStatus(st.status || prof.status));
        setVal('e-stu-dob', normalizeToIsoDate(prof.dob || st.dob || ''));
        setVal('e-stu-adm-date', normalizeToIsoDate(prof.admDate || prof.adm_date || st.admDate || st.adm_date || ''));
        setVal('e-stu-adhaar', prof.adhaar || st.adhaar || '');
        setVal('e-stu-samastha', prof.samasthaId || st.samasthaId || '');
        updateAdminPhotoWidgetPreview(st.photo || st.profile?.photo || '', 'e-stu-photo-preview', 'e-stu-photo-placeholder', 'e-stu-remove-btn', 'e-stu-photo');
        const popup = document.getElementById('edit-student-popup');
        if (popup) {
            popup.classList.remove('hidden');
            popup.classList.add('flex');
        }
    }
};
document.getElementById('edit-student-update')?.addEventListener('click', async () => {
    if(!requirePermission('students.manage')) return;
    const getVal = (id) => (document.getElementById(id)?.value || '').trim();
    const updatedClass = getVal('e-stu-class').toUpperCase();
    const nameVal = getVal('e-stu-name').toUpperCase();
    const genderVal = document.getElementById('e-stu-gender')?.value || 'Male';
    if(!updatedClass || !nameVal || !genderVal) return alert("Class, Name and Gender are mandatory.");
    if(!confirm("Are you sure you want to update this student's information?")) return;
    const photoVal = getVal('e-stu-photo');
    const dobVal = document.getElementById('e-stu-dob')?.value || '';
    const admDateVal = document.getElementById('e-stu-adm-date')?.value || '';
    const adhaarVal = getVal('e-stu-adhaar');
    const samasthaVal = getVal('e-stu-samastha');

    const existingStudent = rawStudents.find((student) => student.id === editingStudentId) || {};
    const updatedPayload = { 
        name: getVal('e-stu-name').toUpperCase(), 
        class: updatedClass, 
        studentClass: updatedClass, // Save both for compatibility
        gender: document.getElementById('e-stu-gender')?.value || 'Male', 
        status: normalizeStudentStatus(document.getElementById('e-stu-status')?.value || 'Active'), 
        adm: getVal('e-stu-adm').toUpperCase(), 
        mobile: getVal('e-stu-mob'), 
        father: getVal('e-stu-fat').toUpperCase(), 
        mother: getVal('e-stu-mother').toUpperCase(),
        motherMobile: getVal('e-stu-mother-mobile'),
        uid: getVal('e-stu-uid'), 
        address: getVal('e-stu-addr'),
        dob: dobVal,
        admDate: admDateVal,
        adm_date: admDateVal,
        adhaar: adhaarVal,
        samasthaId: samasthaVal,
        photo: photoVal,
        profile: {
            dob: dobVal,
            address: getVal('e-stu-addr'),
            adhaar: adhaarVal,
            admNo: getVal('e-stu-adm').toUpperCase(),
            admDate: admDateVal,
            adm_date: admDateVal,
            samasthaId: samasthaVal,
            photo: photoVal,
            uid: getVal('e-stu-uid'),
            father: getVal('e-stu-fat').toUpperCase(),
            mother: getVal('e-stu-mother').toUpperCase(),
            mobile: getVal('e-stu-mob'),
            motherMobile: getVal('e-stu-mother-mobile'),
            status: normalizeStudentStatus(document.getElementById('e-stu-status')?.value || 'Active')
        }
    };
    const activeYearForEdit = activeAcademicYear || currentAcademicYear;
    const existingAcademicYears = existingStudent.academicYears || {};
    updatedPayload.academicYears = {
        ...existingAcademicYears,
        [activeYearForEdit]: {
            class: updatedClass,
            status: updatedPayload.status,
            updatedAt: new Date().toISOString()
        }
    };
    try {
        await updateDoc(doc(db, `${BASE_PATH}/students`, editingStudentId), updatedPayload);
        await setDoc(doc(db, `${BASE_PATH}/studentPhotoSubmissions`, editingStudentId), { photo: photoVal, updatedAt: Date.now() }, { merge: true });
        await syncEnrollmentRecord(editingStudentId, { ...existingStudent, ...updatedPayload });
        await syncActiveAcademicYearClasses([updatedClass]);
        await logAuditEvent({ category: 'student', action: 'student.update', entityType: 'student', entityId: editingStudentId, message: 'Student record updated.' });
        document.getElementById('edit-student-popup').classList.add('hidden');
        renderStudentList();
        if (!document.getElementById('student-continuity-page')?.classList.contains('hidden')) renderContinuityPage();
        alert('Student information updated successfully!');
    } catch (err) {
        console.error('Failed to update student:', err);
        alert('Failed to update student: ' + err.message);
    }
});
document.getElementById('edit-student-cancel').addEventListener('click', () => document.getElementById('edit-student-popup').classList.add('hidden'));

const getManagedStudentsForExport = () => {
    const fCls = document.getElementById('filter-manage-class').value;
    const fGen = document.getElementById('filter-manage-gender').value;
    const fStatus = document.getElementById('filter-manage-status').value;
    const sortType = document.getElementById('sort-manage-students').value;
    const sTerm = document.getElementById('search-student-input').value.toLowerCase();
    const compareByAdmission = (a, b) => {
        const admA = a.adm ? a.adm.toString().trim() : ""; const admB = b.adm ? b.adm.toString().trim() : "";
        if (admA === "" && admB === "") return (a.name || '').localeCompare(b.name || '');
        if (admA === "") return 1; if (admB === "") return -1;
        const numA = parseFloat(admA); const numB = parseFloat(admB);
        if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
        return admA.localeCompare(admB, undefined, {numeric: true});
    };
    const selectedYear = document.getElementById('filter-manage-academic-year')?.value || getActiveAcademicYearLabel();
    const yearStudents = getStudentsForYear(selectedYear);
    const filtered = yearStudents.filter((s) => {
        let match = true;
        if(fCls !== 'all') {
            if (fCls === 'ALUMNI' || fCls === 'GRADUATED') match = match && (normalizeStudentStatus(s.status) === 'Alumni' || String(s.class || '').toUpperCase() === 'ALUMNI' || String(s.class || '').toUpperCase() === 'GRADUATED');
            else match = match && s.class === fCls;
        }
        if(fGen !== 'all') match = match && s.gender === fGen;
        if(fStatus !== 'all') match = match && normalizeStudentStatus(s.status) === fStatus;
        if(sTerm) match = match && ((s.name || '').toLowerCase().includes(sTerm) || ((s.adm || '').toLowerCase().includes(sTerm)));
        return match;
    });
    if (sortType === 'male-first') {
        filtered.sort((a, b) => {
            const genderOrder = (a.gender === 'Male' ? 0 : 1) - (b.gender === 'Male' ? 0 : 1);
            if (genderOrder !== 0) return genderOrder;
            return compareByAdmission(a, b);
        });
    } else if (sortType === 'name-asc') {
        filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else {
        filtered.sort(compareByAdmission);
    }
    return filtered;
};
const buildStudentExportRows = () => {
    const selectedYear = document.getElementById('filter-manage-academic-year')?.value || getActiveAcademicYearLabel();
    return getManagedStudentsForExport().map((student, index) => {
        const prof = student.profile || {};
        return {
            'Sl. No': index + 1,
            'Academic Year': selectedYear,
            'Photo': student.photo ? 'Yes' : 'No',
            'Class': student.class || '',
        'ID/UID': student.uid || '',
        'Student Name': student.name || '',
        "Father's Name": student.father || '',
        "Mother's Name": student.mother || prof.mother || '',
        'Gender': student.gender || '',
        'Admission Number (Adm. No.)': student.adm || '',
        'Date of Birth': prof.dob || '',
        'Date of Admission': prof.admDate || '',
        'Student Status': normalizeStudentStatus(student.status),
        'Aadhaar Number': prof.adhaar || '',
        "Father's Phone Number": student.mobile || '',
        "Mother's Phone Number": student.motherMobile || prof.motherMobile || '',
        'Permanent Address': student.address || ''
    };
});
};
const exportStudentsToExcel = () => {
    const exportRows = buildStudentExportRows();
    if (exportRows.length === 0) {
        alert('No students available to export.');
        return;
    }
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    worksheet['!cols'] = [
        { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 28 }, { wch: 20 },
        { wch: 20 }, { wch: 10 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
        { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 32 }
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');
    XLSX.writeFile(workbook, `students-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
};
const exportStudentsToCSV = () => {
    const exportRows = buildStudentExportRows();
    if (exportRows.length === 0) return alert('No students available to export.');
    const headers = Object.keys(exportRows[0]);
    const csv = [
        headers.join(','),
        ...exportRows.map((row) => headers.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `students-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};
const exportStudentsToPDF = () => {
    const exportRows = buildStudentExportRows();
    if (exportRows.length === 0) return alert('No students available to export.');
    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF({ orientation: 'landscape' });
    docPdf.setFontSize(14);
    docPdf.text('Students Export (Filtered/Sorted)', 14, 14);
    docPdf.autoTable({
        startY: 20,
        head: [['Sl. No', 'Class', 'Adm No', 'Name', 'Gender', 'Status', 'Mobile']],
        body: exportRows.map((row) => [
            row['Sl. No'],
            row['Class'],
            row['Admission Number (Adm. No.)'] || '',
            row['Student Name'] || '',
            row['Gender'] || '',
            row['Student Status'] || '',
            row["Father's Phone Number"] || ''
        ]),
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [37, 99, 235] }
    });
    docPdf.save(`students-export-${new Date().toISOString().slice(0, 10)}.pdf`);
};

document.getElementById('export-students-excel-btn')?.addEventListener('click', exportStudentsToExcel);
document.getElementById('export-students-csv-btn')?.addEventListener('click', exportStudentsToCSV);
document.getElementById('export-students-pdf-btn')?.addEventListener('click', exportStudentsToPDF);

// ============================================================================
// --- 3.2 STUDENT CONTINUITY & RE-ADMISSION MANAGEMENT SUBSYSTEM ---
// ============================================================================

let continuitySelectedStudent = null;

const calculateStudentPreservedDues = (student, exitDate = null) => {
    if (!student) return 0;
    const exitDateStr = exitDate || student.discontinuationDetails?.date || null;
    const pendingItems = getStudentDetailedPendingFees(student, exitDateStr);
    if (pendingItems.length > 0) {
        return pendingItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    }
    if (student.discontinuationDetails && typeof student.discontinuationDetails.preservedDues === 'number') {
        return Math.max(0, student.discontinuationDetails.preservedDues);
    }
    return 0;
};

const calculateGapDurationText = (startDateStr, endDateStr) => {
    if (!startDateStr) return 'Unknown duration';
    const start = new Date(startDateStr);
    const end = endDateStr ? new Date(endDateStr) : new Date();
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return '0 Days';

    let years = end.getFullYear() - start.getFullYear();
    let months = end.getMonth() - start.getMonth();
    let days = end.getDate() - start.getDate();

    if (days < 0) {
        months -= 1;
        const prevMonth = new Date(end.getFullYear(), end.getMonth(), 0);
        days += prevMonth.getDate();
    }
    if (months < 0) {
        years -= 1;
        months += 12;
    }

    const parts = [];
    if (years > 0) parts.push(`${years} ${years === 1 ? 'Year' : 'Years'}`);
    if (months > 0) parts.push(`${months} ${months === 1 ? 'Month' : 'Months'}`);
    if (days > 0 && years === 0) parts.push(`${days} ${days === 1 ? 'Day' : 'Days'}`);
    return parts.length ? parts.join(' ') : 'Less than a day';
};

const getMissedAcademicYears = (exitAcademicYear, targetAcademicYear) => {
    if (!exitAcademicYear || !targetAcademicYear) return [];
    const [startA] = String(exitAcademicYear).split('-').map(Number);
    const [startB] = String(targetAcademicYear).split('-').map(Number);
    if (!startA || !startB || startB <= startA) return [];

    const missed = [];
    for (let yr = startA; yr < startB; yr++) {
        missed.push(`${yr}-${yr + 1}`);
    }
    return missed;
};

const populateContinuityClassDropdown = () => {
    const classSelect = document.getElementById('continuity-class-select');
    const classFilter = document.getElementById('continuity-class-filter');
    if (!classSelect || !classFilter) return;

    const activeClasses = getClassesForActiveYear();
    const currentVal = classSelect.value;
    classSelect.innerHTML = `<option value="">All Classes</option>` +
        activeClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (activeClasses.includes(currentVal)) classSelect.value = currentVal;

    const discontinuedStudents = (rawStudents || []).filter(s => normalizeStudentStatus(s.status) === 'Discontinued');
    const departureClasses = sortClassLabels([...new Set(discontinuedStudents.map(s => s.discontinuationDetails?.lastClass || s.class).filter(Boolean))]);
    const currentFilterVal = classFilter.value;
    classFilter.innerHTML = `<option value="all">All Departure Classes</option>` +
        departureClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (departureClasses.includes(currentFilterVal) || currentFilterVal === 'all') classFilter.value = currentFilterVal;
};

const filterContinuityStudentSuggestions = (term) => {
    const suggestionsBox = document.getElementById('continuity-student-suggestions');
    const clearBtn = document.getElementById('continuity-clear-search-btn');
    if (!suggestionsBox) return;

    const lowerTerm = (term || '').trim().toLowerCase();
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !lowerTerm);
    }

    if (!lowerTerm) {
        suggestionsBox.classList.add('hidden');
        suggestionsBox.innerHTML = '';
        return;
    }

    const selectedClass = document.getElementById('continuity-class-select')?.value || '';
    const activeStudents = (getStudentsForActiveYear() || []).filter(s => {
        const notDiscontinued = normalizeStudentStatus(s.status) !== 'Discontinued';
        const classMatch = !selectedClass || s.class === selectedClass;
        return notDiscontinued && classMatch;
    });

    const matching = activeStudents.filter(s => {
        const nameMatch = (s.name || '').toLowerCase().includes(lowerTerm);
        const admMatch = String(s.adm || '').toLowerCase().includes(lowerTerm);
        const rollMatch = String(s.rollNo || s.roll || '').toLowerCase().includes(lowerTerm);
        const phoneMatch = String(s.phone || s.mobile || '').toLowerCase().includes(lowerTerm);
        return nameMatch || admMatch || rollMatch || phoneMatch;
    }).slice(0, 30);

    matching.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (matching.length === 0) {
        suggestionsBox.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 italic">No matching active students found</div>`;
        suggestionsBox.classList.remove('hidden');
        return;
    }

    suggestionsBox.innerHTML = matching.map(s => {
        const photoUrl = resolveSafePhotoUrl(s.photoUrl || s.photo);
        return `
            <div class="continuity-sugg-item p-2.5 hover:bg-indigo-50/80 cursor-pointer flex items-center justify-between gap-3 text-sm transition" data-id="${s.id}">
                <div class="flex items-center gap-2.5 min-w-0">
                    <img src="${escapeHtml(photoUrl)}" class="w-8 h-8 rounded-full object-cover border border-slate-200 bg-white shrink-0">
                    <div class="min-w-0">
                        <div class="font-bold text-slate-900 text-xs truncate">${escapeHtml(s.name)}</div>
                        <div class="text-[11px] text-slate-500 font-mono">Adm: <b class="text-slate-700">${escapeHtml(s.adm || '--')}</b> · Class: <b class="text-slate-700">${escapeHtml(s.class || '--')}</b></div>
                    </div>
                </div>
                <i class="fas fa-chevron-right text-xs text-slate-300 shrink-0"></i>
            </div>
        `;
    }).join('');

    suggestionsBox.classList.remove('hidden');

    suggestionsBox.querySelectorAll('.continuity-sugg-item').forEach(item => {
        item.addEventListener('click', () => {
            selectContinuityStudent(item.dataset.id);
        });
    });
};

const selectContinuityStudent = (studentId) => {
    const student = (rawStudents || []).find(s => s.id === studentId);
    const searchInput = document.getElementById('continuity-student-search-input');
    const hiddenId = document.getElementById('continuity-selected-student-id');
    const suggestionsBox = document.getElementById('continuity-student-suggestions');
    const clearBtn = document.getElementById('continuity-clear-search-btn');

    if (!student) return;

    if (hiddenId) hiddenId.value = student.id;
    if (searchInput) searchInput.value = `${student.name} (Adm: ${student.adm || '--'})`;
    if (clearBtn) clearBtn.classList.remove('hidden');
    if (suggestionsBox) {
        suggestionsBox.classList.add('hidden');
        suggestionsBox.innerHTML = '';
    }

    updateContinuityStudentPreview(student.id);
};

const clearContinuityStudentSelection = () => {
    const searchInput = document.getElementById('continuity-student-search-input');
    const hiddenId = document.getElementById('continuity-selected-student-id');
    const suggestionsBox = document.getElementById('continuity-student-suggestions');
    const clearBtn = document.getElementById('continuity-clear-search-btn');

    if (searchInput) searchInput.value = '';
    if (hiddenId) hiddenId.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    if (suggestionsBox) {
        suggestionsBox.classList.add('hidden');
        suggestionsBox.innerHTML = '';
    }
    updateContinuityStudentPreview('');
};

const updateContinuityStudentPreview = (studentId) => {
    const previewWrap = document.getElementById('continuity-student-preview');
    const feeWrap = document.getElementById('continuity-fee-settlement-wrap');
    if (!previewWrap) return;

    if (!studentId) {
        previewWrap.classList.add('hidden');
        if (feeWrap) feeWrap.classList.add('hidden');
        continuitySelectedStudent = null;
        return;
    }

    const student = (rawStudents || []).find(s => s.id === studentId);
    if (!student) {
        previewWrap.classList.add('hidden');
        if (feeWrap) feeWrap.classList.add('hidden');
        continuitySelectedStudent = null;
        return;
    }

    continuitySelectedStudent = student;
    const exitDateInput = document.getElementById('continuity-exit-date');
    if (exitDateInput && !exitDateInput.value) {
        exitDateInput.value = new Date().toISOString().split('T')[0];
    }
    const exitDate = exitDateInput?.value || new Date().toISOString().split('T')[0];

    const photoEl = document.getElementById('continuity-preview-photo');
    if (photoEl) photoEl.src = resolveSafePhotoUrl(student.photoUrl || student.photo);
    document.getElementById('continuity-preview-name').textContent = student.name || 'Unknown';
    document.getElementById('continuity-preview-adm').textContent = student.adm || '--';
    document.getElementById('continuity-preview-class').textContent = student.class || '--';
    document.getElementById('continuity-preview-gender').textContent = student.gender || '--';
    document.getElementById('continuity-preview-guardian').textContent = student.guardian || student.father || '--';
    document.getElementById('continuity-preview-phone').textContent = student.phone || student.mobile || '--';

    previewWrap.classList.remove('hidden');

    renderContinuityPendingFees(student, exitDate);
};

const getNextReceiptNo = () => {
    const receipts = (allPayments || [])
        .map(p => Number(p.receiptNo))
        .filter(n => Number.isFinite(n) && n > 0);
    return receipts.length ? Math.max(...receipts) + 1 : 1;
};

const parseAcademicStartYear = (yrLabel) => {
    if (!yrLabel) return 0;
    const match = String(yrLabel).match(/^(\d{4})/);
    return match ? parseInt(match[1], 10) : 0;
};

const getStudentDetailedPendingFees = (student, exitDateStr = null) => {
    if (!student) return [];

    const effectiveExitDateStr = exitDateStr || student.discontinuationDetails?.date || null;
    const isDiscontinued = (normalizeStudentStatus(student.status) === 'Discontinued') || Boolean(student.discontinuationDetails?.date);

    // Target academic year: For discontinued students, strictly evaluate against their exit year (or enrollment year)
    let targetAcademicYear = getActiveAcademicYearLabel();
    if (isDiscontinued) {
        targetAcademicYear = student.discontinuationDetails?.academicYear || student.academicYear || targetAcademicYear;
    }

    const targetYearRecord = (typeof allAcademicYears !== 'undefined' && Array.isArray(allAcademicYears))
        ? allAcademicYears.find(y => y.label === targetAcademicYear || y.id === targetAcademicYear)
        : getActiveAcademicYearRecord();

    const studentPayments = (allPayments || []).filter(p => p.studentId === student.id || p.admissionNo === student.adm);
    const paidItemKeys = new Set(studentPayments.map(p => `${p.itemKey}__${p.academicYear || targetAcademicYear}`));

    const effectiveMonthlyFee = (student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '')
        ? Number(student.concessionFee)
        : (feeItems.find(f => f.type === 'monthly')?.amount || 200);

    const pendingItems = [];

    // Parse Exit Boundaries
    let exitCutoffDate = null;
    let exitCutoffTimestamp = null;
    if (effectiveExitDateStr) {
        const parsedExit = new Date(effectiveExitDateStr);
        if (!isNaN(parsedExit.getTime())) {
            // Cutoff timestamp is the end of the departure day (23:59:59.999)
            exitCutoffTimestamp = new Date(parsedExit.getFullYear(), parsedExit.getMonth(), parsedExit.getDate(), 23, 59, 59, 999).getTime();
            // Monthly fee cutoff: end of the departure month
            exitCutoffDate = new Date(parsedExit.getFullYear(), parsedExit.getMonth() + 1, 0, 23, 59, 59);
        }
    }

    const exitStartYear = parseAcademicStartYear(targetAcademicYear);

    // 1. Monthly fee items
    const monthSequence = typeof getAcademicMonthSequence === 'function' ? getAcademicMonthSequence(targetYearRecord) : [4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3];
    const startYear = parseAcademicStartYear(targetAcademicYear) || new Date().getFullYear();

    const monthCalendarMap = new Map();
    let curYr = startYear;
    let prevM = -1;
    monthSequence.forEach(mIdx => {
        if (prevM !== -1 && mIdx < prevM) {
            curYr = startYear + 1;
        }
        monthCalendarMap.set(mIdx, { year: curYr, month: mIdx });
        prevM = mIdx;
    });

    const scopedMonthlyItems = feeItems.filter(item => {
        const itemType = item.type || 'month';
        if (itemType !== 'month') return false;
        const itemYear = item.academicYear || targetAcademicYear;
        // Discontinued students must NEVER be billed for future academic years
        if (isDiscontinued && parseAcademicStartYear(itemYear) > exitStartYear) return false;
        return itemYear === targetAcademicYear;
    });

    scopedMonthlyItems.sort((a, b) => {
        const aName = (a.name || '').split('(')[0].trim();
        const bName = (b.name || '').split('(')[0].trim();
        const aIdx = Array.isArray(MONTH_LABELS) ? MONTH_LABELS.indexOf(aName) : -1;
        const bIdx = Array.isArray(MONTH_LABELS) ? MONTH_LABELS.indexOf(bName) : -1;
        return monthSequence.indexOf(aIdx) - monthSequence.indexOf(bIdx);
    });

    scopedMonthlyItems.forEach(item => {
        const rawName = (item.name || '').split('(')[0].trim();
        const mIdx = Array.isArray(MONTH_LABELS) ? MONTH_LABELS.indexOf(rawName) : -1;

        // If an exit cutoff date exists, only include months that began on or before the departure month
        if (exitCutoffDate && mIdx !== -1 && monthCalendarMap.has(mIdx)) {
            const cal = monthCalendarMap.get(mIdx);
            const monthStart = new Date(cal.year, cal.month, 1);
            if (monthStart > exitCutoffDate) {
                return; // Month started after departure date; do not bill
            }
        }

        const itemKey = `${item.key}__${targetAcademicYear}`;
        const isPaid = paidItemKeys.has(itemKey) || studentPayments.some(p => p.itemKey === item.key && (p.academicYear || targetAcademicYear) === targetAcademicYear);
        if (!isPaid) {
            pendingItems.push({
                key: item.key,
                name: item.name || 'Monthly Fee',
                type: 'month',
                amount: effectiveMonthlyFee,
                academicYear: targetAcademicYear
            });
        }
    });

    // 2. Custom / Other fee items
    const studentClass = student.discontinuationDetails?.lastClass || student.class || '';

    const scopedCustomItems = feeItems.filter(item => {
        if (item.type !== 'custom' || item.isVisible === false) return false;
        const itemYear = item.academicYear || targetAcademicYear;
        // Discontinued students must NEVER be billed for future academic years
        if (isDiscontinued && parseAcademicStartYear(itemYear) > exitStartYear) return false;
        return itemYear === targetAcademicYear;
    });

    scopedCustomItems.forEach(item => {
        // If student has an exit cutoff timestamp, check if item was added or effective AFTER departure
        if (exitCutoffTimestamp) {
            let itemTimestamp = null;
            if (item.timestamp && Number.isFinite(Number(item.timestamp))) {
                itemTimestamp = Number(item.timestamp);
            } else if (item.createdAt) {
                const parsedCreated = new Date(item.createdAt).getTime();
                if (!isNaN(parsedCreated)) itemTimestamp = parsedCreated;
            } else if (typeof item.key === 'string' && item.key.startsWith('custom-')) {
                const num = parseInt(item.key.replace('custom-', ''), 10);
                if (!isNaN(num) && num > 1000000000) itemTimestamp = num;
            }

            // If item was created in settings after the student's exit date, DO NOT charge the student
            if (itemTimestamp && itemTimestamp > exitCutoffTimestamp) {
                return;
            }

            // If fee item has an explicit date or effective date after departure, DO NOT charge
            if (item.date || item.effectiveDate) {
                const itemDate = new Date(item.date || item.effectiveDate).getTime();
                if (!isNaN(itemDate) && itemDate > exitCutoffTimestamp) {
                    return;
                }
            }
        }

        let amount = 0;
        if (item.scope === 'global') amount = Number(item.amount || 0);
        else if (item.scope === 'class-wise' && item.classValues) amount = Number(item.classValues[studentClass] || 0);
        else if (item.scope === 'specific' && item.targetClass === studentClass) amount = Number(item.amount || 0);

        if (amount > 0) {
            const itemKey = `${item.key}__${targetAcademicYear}`;
            const isPaid = paidItemKeys.has(itemKey) || studentPayments.some(p => p.itemKey === item.key && (p.academicYear || targetAcademicYear) === targetAcademicYear);
            if (!isPaid) {
                pendingItems.push({
                    key: item.key,
                    name: item.name || 'Other Fee',
                    type: 'custom',
                    amount: amount,
                    academicYear: targetAcademicYear
                });
            }
        }
    });

    return pendingItems;
};

const updateContinuitySelectedFeeTotal = () => {
    const checkedBoxes = Array.from(document.querySelectorAll('.continuity-fee-checkbox:checked'));
    const total = checkedBoxes.reduce((sum, cb) => sum + Number(cb.dataset.amount || 0), 0);
    const totalEl = document.getElementById('continuity-selected-fee-total');
    if (totalEl) totalEl.textContent = `₹${total.toLocaleString('en-IN')}`;

    const studentId = document.getElementById('continuity-selected-student-id')?.value;
    const student = (rawStudents || []).find(s => s.id === studentId);
    const exitDate = document.getElementById('continuity-exit-date')?.value || null;
    const pendingItems = student ? getStudentDetailedPendingFees(student, exitDate) : [];
    const totalUnpaid = pendingItems.reduce((sum, it) => sum + Number(it.amount || 0), 0);

    const totalUnpaidEl = document.getElementById('continuity-total-unpaid-dues');
    if (totalUnpaidEl) totalUnpaidEl.textContent = `₹${totalUnpaid.toLocaleString('en-IN')}`;

    const remaining = Math.max(0, totalUnpaid - total);
    const remEl = document.getElementById('continuity-remaining-fee-balance');
    if (remEl) {
        remEl.textContent = `₹${remaining.toLocaleString('en-IN')}`;
        if (remaining === 0 && total > 0) {
            remEl.className = 'text-xs sm:text-sm font-extrabold text-emerald-700 tabular-nums';
        } else {
            remEl.className = 'text-xs sm:text-sm font-extrabold text-rose-700 tabular-nums';
        }
    }

    const collectFeeCheckbox = document.getElementById('continuity-collect-fee-now');
    if (collectFeeCheckbox) {
        if (total > 0 && !collectFeeCheckbox.checked) {
            collectFeeCheckbox.checked = true;
            const receiptInput = document.getElementById('continuity-fee-receipt-no');
            const paymentDateInput = document.getElementById('continuity-fee-payment-date');
            if (receiptInput && !receiptInput.value) receiptInput.value = getNextReceiptNo();
            if (paymentDateInput && !paymentDateInput.value) paymentDateInput.value = exitDate || new Date().toISOString().split('T')[0];
        }
    }

    const container = document.getElementById('continuity-fee-items-container');
    if (container) {
        container.querySelectorAll('.continuity-fee-card').forEach(card => {
            const cb = card.querySelector('.continuity-fee-checkbox');
            const amtEl = card.querySelector('.continuity-fee-card-amount');
            if (cb && cb.checked) {
                card.classList.remove('border-slate-200', 'bg-white', 'opacity-70');
                card.classList.add('border-emerald-500', 'bg-emerald-50/80', 'ring-1', 'ring-emerald-400/70', 'opacity-100');
                if (amtEl) {
                    amtEl.classList.remove('text-slate-700');
                    amtEl.classList.add('text-emerald-800');
                }
            } else if (cb) {
                card.classList.remove('border-emerald-500', 'bg-emerald-50/80', 'ring-1', 'ring-emerald-400/70', 'opacity-100');
                card.classList.add('border-slate-200', 'bg-white', 'opacity-70');
                if (amtEl) {
                    amtEl.classList.remove('text-emerald-800');
                    amtEl.classList.add('text-slate-700');
                }
            }
        });
    }
    return total;
};

const renderContinuityPendingFees = (student, exitDateStr) => {
    const feeWrap = document.getElementById('continuity-fee-settlement-wrap');
    const container = document.getElementById('continuity-fee-items-container');
    const duesEl = document.getElementById('continuity-preview-dues');
    const totalUnpaidEl = document.getElementById('continuity-total-unpaid-dues');
    const collectFeeCheckbox = document.getElementById('continuity-collect-fee-now');
    const receiptInput = document.getElementById('continuity-fee-receipt-no');
    const paymentDateInput = document.getElementById('continuity-fee-payment-date');

    if (!feeWrap || !container) return;

    const pendingItems = getStudentDetailedPendingFees(student, exitDateStr);
    const totalPendingDues = pendingItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    if (duesEl) duesEl.textContent = `₹${totalPendingDues.toLocaleString('en-IN')}`;
    if (totalUnpaidEl) totalUnpaidEl.textContent = `₹${totalPendingDues.toLocaleString('en-IN')}`;

    if (pendingItems.length === 0) {
        container.innerHTML = `
            <div class="col-span-full p-3 bg-emerald-50 text-emerald-800 rounded-xl text-xs font-semibold border border-emerald-200 flex items-center justify-center gap-2">
                <i class="fas fa-check-circle text-emerald-600 text-sm"></i>
                <span>All fees are fully cleared. No outstanding dues found for this student.</span>
            </div>
        `;
        if (collectFeeCheckbox) {
            collectFeeCheckbox.checked = false;
            collectFeeCheckbox.disabled = true;
        }
        updateContinuitySelectedFeeTotal();
        feeWrap.classList.remove('hidden');
        return;
    }

    if (collectFeeCheckbox) {
        collectFeeCheckbox.disabled = false;
        collectFeeCheckbox.checked = false; // Default: unselected
    }

    if (receiptInput) receiptInput.value = '';
    if (paymentDateInput) paymentDateInput.value = exitDateStr || new Date().toISOString().split('T')[0];

    // Render fee items unselected by default
    container.innerHTML = pendingItems.map((item, idx) => `
        <label for="cont-fee-${idx}" class="continuity-fee-card flex flex-col justify-between p-2 rounded-lg border border-slate-200 bg-white opacity-70 shadow-xs cursor-pointer transition select-none hover:shadow-sm" data-idx="${idx}">
            <div class="flex items-start justify-between gap-1">
                <div class="min-w-0 flex-1">
                    <div class="text-xs font-bold text-slate-900 truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                    <div class="text-[10px] text-slate-500 truncate">${item.type === 'month' ? 'Monthly' : 'Item'} · ${escapeHtml(item.academicYear)}</div>
                </div>
                <input type="checkbox" id="cont-fee-${idx}" class="continuity-fee-checkbox w-3.5 h-3.5 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 shrink-0 mt-0.5"
                       data-key="${escapeHtml(item.key)}" data-type="${escapeHtml(item.type)}" data-amount="${item.amount}" data-name="${escapeHtml(item.name)}" data-year="${escapeHtml(item.academicYear)}">
            </div>
            <div class="mt-1.5 pt-1 border-t border-slate-200/60 flex items-center justify-between">
                <span class="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Fee</span>
                <span class="continuity-fee-card-amount text-xs font-extrabold font-mono tabular-nums text-slate-700">₹${Number(item.amount).toLocaleString('en-IN')}</span>
            </div>
        </label>
    `).join('');

    container.querySelectorAll('.continuity-fee-checkbox').forEach(cb => {
        cb.addEventListener('change', updateContinuitySelectedFeeTotal);
    });

    const selectAllBtn = document.getElementById('continuity-fee-select-all-btn');
    if (selectAllBtn) {
        selectAllBtn.onclick = () => {
            container.querySelectorAll('.continuity-fee-checkbox').forEach(cb => cb.checked = true);
            if (collectFeeCheckbox) collectFeeCheckbox.checked = true;
            if (receiptInput && !receiptInput.value) receiptInput.value = getNextReceiptNo();
            if (paymentDateInput && !paymentDateInput.value) paymentDateInput.value = exitDateStr || new Date().toISOString().split('T')[0];
            updateContinuitySelectedFeeTotal();
        };
    }

    const deselectAllBtn = document.getElementById('continuity-fee-deselect-all-btn');
    if (deselectAllBtn) {
        deselectAllBtn.onclick = () => {
            container.querySelectorAll('.continuity-fee-checkbox').forEach(cb => cb.checked = false);
            if (collectFeeCheckbox) collectFeeCheckbox.checked = false;
            updateContinuitySelectedFeeTotal();
        };
    }

    if (collectFeeCheckbox) {
        collectFeeCheckbox.onchange = () => {
            if (collectFeeCheckbox.checked) {
                if (receiptInput && !receiptInput.value) receiptInput.value = getNextReceiptNo();
                if (paymentDateInput && !paymentDateInput.value) paymentDateInput.value = exitDateStr || new Date().toISOString().split('T')[0];
                const anyChecked = container.querySelector('.continuity-fee-checkbox:checked');
                if (!anyChecked) {
                    container.querySelectorAll('.continuity-fee-checkbox').forEach(cb => cb.checked = true);
                }
            } else {
                container.querySelectorAll('.continuity-fee-checkbox').forEach(cb => cb.checked = false);
            }
            updateContinuitySelectedFeeTotal();
        };
    }

    updateContinuitySelectedFeeTotal();
    feeWrap.classList.remove('hidden');
};

const handleDiscontinueStudent = async (e) => {
    e.preventDefault();
    const hiddenStudentIdInput = document.getElementById('continuity-selected-student-id');
    const exitDateInput = document.getElementById('continuity-exit-date');
    const exitReasonInput = document.getElementById('continuity-exit-reason');
    const collectFeeCheckbox = document.getElementById('continuity-collect-fee-now');
    const submitBtn = document.getElementById('execute-discontinue-btn');

    const studentId = hiddenStudentIdInput?.value;
    const exitDate = exitDateInput?.value;
    const exitReason = (exitReasonInput?.value || '').trim();
    const collectFeesNow = !!collectFeeCheckbox?.checked;

    if (!studentId) {
        alert('Please search and select a student to discontinue.');
        return;
    }
    if (!exitDate) {
        alert('Please specify the departure date.');
        return;
    }

    const student = (rawStudents || []).find(s => s.id === studentId);
    if (!student) {
        alert('Student record not found.');
        return;
    }

    const pendingItems = getStudentDetailedPendingFees(student, exitDate);
    const totalPendingDues = pendingItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    let itemsToCollect = [];
    let collectedAmount = 0;
    let receiptNo = null;
    let paymentDate = exitDate;
    let paymentMode = 'Cash';
    let paymentDesc = '';

    if (collectFeesNow) {
        const checkedBoxes = Array.from(document.querySelectorAll('.continuity-fee-checkbox:checked'));
        itemsToCollect = checkedBoxes.map(cb => ({
            key: cb.dataset.key,
            name: cb.dataset.name,
            type: cb.dataset.type,
            amount: Number(cb.dataset.amount || 0),
            academicYear: cb.dataset.year || getActiveAcademicYearLabel()
        }));

        if (itemsToCollect.length === 0) {
            alert('Fee collection was enabled, but no fee items were selected. Please tick at least one fee item or uncheck "Collect Selected Fees".');
            return;
        }

        collectedAmount = itemsToCollect.reduce((sum, it) => sum + it.amount, 0);

        const receiptInput = document.getElementById('continuity-fee-receipt-no');
        const rcptVal = (receiptInput?.value || '').trim();
        receiptNo = rcptVal ? parseInt(rcptVal, 10) : null;
        paymentDate = document.getElementById('continuity-fee-payment-date')?.value || exitDate;
        paymentMode = document.getElementById('continuity-fee-payment-mode')?.value || 'Cash';
        paymentDesc = (document.getElementById('continuity-fee-description')?.value || '').trim() || 'Settled upon student discontinuation';
    }

    const remainingPreservedDues = Math.max(0, totalPendingDues - collectedAmount);
    const activeYear = getActiveAcademicYearLabel();
    const lastClass = student.class || '';

    const confirmMsg = `Are you sure you want to discontinue student:\n\n` +
        `• Name: ${student.name}\n` +
        `• Admission No: ${student.adm || '--'}\n` +
        `• Class: ${lastClass}\n` +
        `• Departure Date: ${formatDateDisplay(exitDate)}\n` +
        (collectFeesNow ? `• Fees to Collect Now: ₹${collectedAmount.toLocaleString('en-IN')} (Receipt: ${receiptNo || 'Auto'})\n` : `• Immediate Fee Collection: None (Optional)\n`) +
        `• Preserved Remaining Dues: ₹${remainingPreservedDues.toLocaleString('en-IN')}\n\n` +
        `This will move the student to the Discontinued Archive. Historical records and remaining fees will be preserved.`;

    if (!confirm(confirmMsg)) return;

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Processing...</span>';
        }

        // 1. If fees are collected, write payment records using batch
        if (collectFeesNow && itemsToCollect.length > 0) {
            const batch = writeBatch(db);
            const txnId = `TXN_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const collectorKey = currentAdminEmail || 'admin';
            const collectorName = currentAdminEmail || 'Administrator';

            itemsToCollect.forEach(item => {
                const paymentPayload = {
                    receiptNo: receiptNo,
                    transactionId: txnId,
                    paymentDate: paymentDate,
                    paymentMode: paymentMode,
                    timestamp: Date.now(),
                    description: paymentDesc,
                    collectedBy: collectorKey,
                    collectedByName: collectorName,
                    academicYear: item.academicYear || activeYear,
                    classLabel: lastClass,
                    studentId: student.id,
                    admissionNo: student.adm || '',
                    studentName: student.name || '',
                    itemKey: item.key,
                    amount: item.amount,
                    billingGroupId: null
                };

                const paymentRef = doc(collection(db, `${BASE_PATH}/payments`));
                batch.set(paymentRef, paymentPayload);
                const yearPath = `${BASE_PATH}/academicYears/${toAcademicYearDocId(item.academicYear || activeYear)}/payments`;
                batch.set(doc(db, yearPath, paymentRef.id), paymentPayload);
            });

            await batch.commit();

            await logAuditEvent({
                category: 'fee',
                action: 'payment.create',
                entityType: 'payment',
                entityId: txnId,
                message: `Collected ₹${collectedAmount} for ${student.name} (Adm: ${student.adm || '-'}) upon discontinuation. Receipt: ${receiptNo || '-'}.`
            });
        }

        // 2. Update Student Document
        const currentAcademicYearsMap = student.academicYears && typeof student.academicYears === 'object'
            ? { ...student.academicYears }
            : {};
        
        currentAcademicYearsMap[activeYear] = {
            ...(currentAcademicYearsMap[activeYear] || {}),
            class: lastClass,
            status: 'Discontinued',
            discontinuedAt: exitDate,
            reason: exitReason
        };

        const currentContinuityLog = Array.isArray(student.continuityLog)
            ? [...student.continuityLog]
            : [];

        currentContinuityLog.unshift({
            id: 'event_' + Date.now(),
            type: 'discontinue',
            timestamp: new Date().toISOString(),
            date: exitDate,
            academicYear: activeYear,
            class: lastClass,
            reason: exitReason || 'Administrative departure',
            adminEmail: currentAdminEmail || 'Admin',
            feesCollected: collectedAmount,
            receiptNo: receiptNo,
            priorBalance: remainingPreservedDues
        });

        const discontinuationDetails = {
            date: exitDate,
            academicYear: activeYear,
            lastClass: lastClass,
            reason: exitReason || 'Administrative departure',
            recordedBy: currentAdminEmail || 'Admin',
            recordedAt: new Date().toISOString(),
            preservedDues: remainingPreservedDues,
            feesCollected: collectedAmount
        };

        const studentRef = doc(db, `${BASE_PATH}/students`, studentId);
        await updateDoc(studentRef, {
            status: 'Discontinued',
            discontinuationDetails,
            academicYears: currentAcademicYearsMap,
            continuityLog: currentContinuityLog,
            updatedAt: new Date().toISOString()
        });

        await syncEnrollmentRecord(studentId, {
            ...student,
            class: lastClass,
            academicYear: activeYear,
            status: 'Discontinued'
        });

        await logAuditEvent({
            category: 'student',
            action: 'student.discontinue',
            entityType: 'student',
            entityId: studentId,
            message: `Student discontinued: ${student.name} (Adm: ${student.adm || '-'}, Class: ${lastClass}). Collected: ₹${collectedAmount}. Preserved dues: ₹${remainingPreservedDues}.`
        });

        showToast(`Student ${student.name} successfully discontinued.${collectedAmount > 0 ? ` Collected ₹${collectedAmount}.` : ''}`, 'success');

        exitReasonInput.value = '';
        if (collectFeeCheckbox) collectFeeCheckbox.checked = false;
        clearContinuityStudentSelection();

        renderContinuityPage();
        refreshAcademicYearScopedData();

    } catch (err) {
        console.error('Failed to discontinue student:', err);
        alert('Failed to discontinue student: ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-user-minus"></i> <span>Discontinue Student</span>';
        }
    }
};

const renderContinuityPage = () => {
    const activeYearDisplay = document.getElementById('continuity-active-year-display');
    if (activeYearDisplay) activeYearDisplay.textContent = getActiveAcademicYearLabel();

    const exitDateInput = document.getElementById('continuity-exit-date');
    if (exitDateInput && !exitDateInput.value) {
        exitDateInput.value = new Date().toISOString().split('T')[0];
    }

    populateContinuityClassDropdown();

    const searchTerm = (document.getElementById('continuity-search-input')?.value || '').toLowerCase().trim();
    const classFilter = document.getElementById('continuity-class-filter')?.value || 'all';
    const tbody = document.getElementById('discontinued-students-table-body');
    const metricTotalEl = document.getElementById('continuity-metric-total');
    const metricDuesEl = document.getElementById('continuity-metric-dues');

    const allDiscontinued = (rawStudents || []).filter(s => normalizeStudentStatus(s.status) === 'Discontinued');

    const totalDues = allDiscontinued.reduce((sum, s) => sum + calculateStudentPreservedDues(s), 0);
    if (metricTotalEl) metricTotalEl.textContent = allDiscontinued.length;
    if (metricDuesEl) metricDuesEl.textContent = `₹${totalDues.toLocaleString('en-IN')}`;

    const filtered = allDiscontinued.filter(s => {
        const exitClass = s.discontinuationDetails?.lastClass || s.class || '';
        if (classFilter !== 'all' && exitClass !== classFilter) return false;
        if (searchTerm) {
            const nameMatch = (s.name || '').toLowerCase().includes(searchTerm);
            const admMatch = String(s.adm || '').toLowerCase().includes(searchTerm);
            const reasonMatch = (s.discontinuationDetails?.reason || '').toLowerCase().includes(searchTerm);
            return nameMatch || admMatch || reasonMatch;
        }
        return true;
    });

    if (!tbody) return;

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="p-8 text-center text-slate-500 font-medium">
                    ${allDiscontinued.length === 0 ? 'No discontinued students recorded in the institution.' : 'No discontinued students match your search filter.'}
                </td>
            </tr>
        `;
        return;
    }

    filtered.sort((a, b) => {
        const dateA = a.discontinuationDetails?.date || a.updatedAt || '';
        const dateB = b.discontinuationDetails?.date || b.updatedAt || '';
        return dateB.localeCompare(dateA);
    });

    tbody.innerHTML = filtered.map(s => {
        const details = s.discontinuationDetails || {};
        const exitClass = details.lastClass || s.class || '--';
        const exitYear = details.academicYear || s.academicYear || '--';
        const exitDate = details.date ? formatDateDisplay(details.date) : '--';
        const reason = details.reason || 'Not specified';
        const gapText = details.date ? calculateGapDurationText(details.date, null) : '--';
        const preservedDues = calculateStudentPreservedDues(s);
        const photoUrl = resolveSafePhotoUrl(s.photoUrl || s.photo);

        return `
            <tr class="hover:bg-slate-50/70 transition">
                <td class="py-3 px-4">
                    <div class="flex items-center gap-3">
                        <img src="${escapeHtml(photoUrl)}" alt="Photo" class="w-9 h-9 rounded-full object-cover border border-slate-200 bg-white shrink-0">
                        <div class="min-w-0">
                            <div class="font-extrabold text-slate-900 truncate">${escapeHtml(s.name)}</div>
                            <div class="text-xs text-slate-500 font-mono space-x-1.5">
                                <span>Adm: <b class="text-slate-700">${escapeHtml(s.adm || '--')}</b></span>
                                <span>·</span>
                                <span>${escapeHtml(s.gender || '--')}</span>
                            </div>
                        </div>
                    </div>
                </td>
                <td class="py-3 px-4 font-mono text-xs">
                    <div class="font-bold text-slate-800">${escapeHtml(exitClass)}</div>
                    <div class="text-slate-500">${escapeHtml(exitYear)}</div>
                </td>
                <td class="py-3 px-4 font-mono text-xs tabular-nums text-slate-800" title="${escapeHtml(reason)}">
                    ${escapeHtml(exitDate)}
                </td>
                <td class="py-3 px-4 font-mono text-xs tabular-nums text-slate-600">
                    <span class="inline-block py-0.5 px-2 rounded bg-slate-100 text-slate-700 border border-slate-200/80">${escapeHtml(gapText)}</span>
                </td>
                <td class="py-3 px-4 text-right font-mono tabular-nums font-bold text-rose-700">
                    ₹${preservedDues.toLocaleString('en-IN')}
                </td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1.5">
                        <button type="button" class="btn-quick-settle-fee px-2.5 py-1.5 ${preservedDues > 0 ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer' : 'bg-slate-100 text-slate-400 cursor-default'} rounded-lg text-xs font-bold transition flex items-center gap-1" data-id="${s.id}" title="${preservedDues > 0 ? 'Collect Preserved Fees' : 'All Fees Cleared'}">
                            <i class="fas fa-receipt text-[10px]"></i>
                            <span>Collect Fee</span>
                        </button>
                        <button type="button" class="btn-open-readmit px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition flex items-center gap-1 cursor-pointer" data-id="${s.id}" title="Re-admit Student">
                            <i class="fas fa-user-plus text-[10px]"></i>
                            <span>Re-admit</span>
                        </button>
                        <button type="button" class="btn-edit-discontinued px-2 py-1.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer" data-id="${s.id}" title="Edit Student Profile">
                            <i class="fas fa-pen-to-square text-[11px] text-slate-600"></i>
                            <span>Edit</span>
                        </button>
                        <button type="button" class="btn-view-continuity px-2 py-1.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer" data-id="${s.id}" title="View Lifecycle History">
                            <i class="fas fa-clock-rotate-left text-[11px] text-slate-500"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Reliable event delegation on tbody
    tbody.onclick = (e) => {
        const quickSettleBtn = e.target.closest('.btn-quick-settle-fee');
        if (quickSettleBtn) {
            e.stopPropagation();
            openQuickSettleModal(quickSettleBtn.dataset.id);
            return;
        }
        const editBtn = e.target.closest('.btn-edit-discontinued');
        if (editBtn) {
            e.stopPropagation();
            openEditStudentModal(editBtn.dataset.id);
            return;
        }
        const readmitBtn = e.target.closest('.btn-open-readmit');
        if (readmitBtn) {
            e.stopPropagation();
            openReadmitModal(readmitBtn.dataset.id);
            return;
        }
        const historyBtn = e.target.closest('.btn-view-continuity');
        if (historyBtn) {
            e.stopPropagation();
            openContinuityHistoryModal(historyBtn.dataset.id);
            return;
        }
    };
};

const openReadmitModal = (studentId) => {
    try {
        const modal = document.getElementById('readmission-popup');
        if (!modal) {
            console.error('Modal readmission-popup not found');
            return;
        }

        const student = (rawStudents || []).find(s => s.id === studentId);
        if (!student) {
            alert('Student not found.');
            return;
        }

        const idInput = document.getElementById('readmit-student-id');
        if (idInput) idInput.value = student.id;

        const photoEl = document.getElementById('readmit-student-photo');
        if (photoEl) photoEl.src = resolveSafePhotoUrl(student.photoUrl || student.photo);

        const nameEl = document.getElementById('readmit-student-name');
        if (nameEl) nameEl.textContent = student.name || 'Unknown';

        const admEl = document.getElementById('readmit-student-adm');
        if (admEl) admEl.textContent = student.adm || '--';

        const details = student.discontinuationDetails || {};
        const exitClass = details.lastClass || student.class || '--';
        const exitDate = details.date || '';
        const exitYear = details.academicYear || student.academicYear || '';
        const exitReason = details.reason || '';

        const exitClassEl = document.getElementById('readmit-student-exit-class');
        if (exitClassEl) exitClassEl.textContent = exitClass;

        const exitDateEl = document.getElementById('readmit-student-exit-date');
        if (exitDateEl) exitDateEl.textContent = exitDate ? formatDateDisplay(exitDate) : '--';

        const reasonWrap = document.getElementById('readmit-student-exit-reason-wrap');
        const reasonEl = document.getElementById('readmit-student-exit-reason');
        if (exitReason && reasonWrap && reasonEl) {
            reasonEl.textContent = exitReason;
            reasonWrap.classList.remove('hidden');
        } else if (reasonWrap) {
            reasonWrap.classList.add('hidden');
        }

        const targetYearSelect = document.getElementById('readmit-target-year');
        if (!targetYearSelect) return;

        const availableYears = (academicYears || []).map(y => y.label).filter(Boolean);
        const activeYear = getActiveAcademicYearLabel();
        if (!availableYears.includes(activeYear)) availableYears.unshift(activeYear);

        targetYearSelect.innerHTML = availableYears.map(yr => {
            const isCurrent = yr === activeYear ? ' (Active Year)' : '';
            return `<option value="${escapeHtml(yr)}">${escapeHtml(yr)}${isCurrent}</option>`;
        }).join('');
        targetYearSelect.value = activeYear;

        const updateTargetClassAndGap = () => {
            const selectedTargetYear = targetYearSelect.value;
            const targetClassSelect = document.getElementById('readmit-target-class');
            if (!targetClassSelect) return;
            const yearClasses = getClassesForYear(selectedTargetYear);

            targetClassSelect.innerHTML = '<option value="">Select Target Class &amp; Division...</option>' +
                yearClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

            const matchDigits = String(exitClass || '').match(/\d+/);
            if (matchDigits) {
                const nextClassNum = parseInt(matchDigits[0], 10) + 1;
                const suggestedClass = yearClasses.find(c => c.includes(String(nextClassNum)));
                if (suggestedClass) targetClassSelect.value = suggestedClass;
            }
            if (!targetClassSelect.value && yearClasses.length > 0) {
                targetClassSelect.value = yearClasses[0];
            }

            const missedYears = getMissedAcademicYears(exitYear, selectedTargetYear);
            const returnDateInput = document.getElementById('readmit-return-date');
            const returnDateVal = returnDateInput?.value || new Date().toISOString().split('T')[0];
            const gapDurationText = exitDate ? calculateGapDurationText(exitDate, returnDateVal) : 'Unknown';

            const gapBadgeEl = document.getElementById('readmit-gap-badge');
            const gapSummaryEl = document.getElementById('readmit-gap-summary');
            if (gapBadgeEl) gapBadgeEl.textContent = gapDurationText;

            if (gapSummaryEl) {
                if (missedYears.length > 0) {
                    gapSummaryEl.innerHTML = `<b>${missedYears.length} Missed Academic Year(s):</b> ${missedYears.join(' · ')}<br><span class="text-[11px] text-emerald-700">Student was on academic leave during these years.</span>`;
                } else {
                    gapSummaryEl.textContent = `Returning within the same or immediate consecutive academic cycle. Inactive Gap: ${gapDurationText}.`;
                }
            }

            const preservedDues = calculateStudentPreservedDues(student, exitDate);
            const duesEl = document.getElementById('readmit-preserved-dues');
            if (duesEl) duesEl.textContent = `₹${preservedDues.toLocaleString('en-IN')}`;
        };

        targetYearSelect.onchange = updateTargetClassAndGap;

        const returnDateInput = document.getElementById('readmit-return-date');
        if (returnDateInput) {
            returnDateInput.value = new Date().toISOString().split('T')[0];
            returnDateInput.onchange = updateTargetClassAndGap;
        }

        const notesInput = document.getElementById('readmit-notes');
        if (notesInput) notesInput.value = '';

        updateTargetClassAndGap();

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    } catch (err) {
        console.error('Error opening readmit modal:', err);
        alert('Could not open Re-admit modal: ' + err.message);
    }
};

const handleExecuteReadmission = async (e) => {
    e.preventDefault();
    const studentId = document.getElementById('readmit-student-id').value;
    const targetYear = document.getElementById('readmit-target-year').value;
    const targetClass = document.getElementById('readmit-target-class').value;
    const returnDate = document.getElementById('readmit-return-date').value;
    const readmitNotes = (document.getElementById('readmit-notes').value || '').trim();
    const commitBtn = document.getElementById('readmit-commit-btn');

    if (!studentId || !targetYear || !targetClass || !returnDate) {
        alert('Please fill all required fields: Target Academic Year, Target Class, and Return Date.');
        return;
    }

    const student = (rawStudents || []).find(s => s.id === studentId);
    if (!student) {
        alert('Student not found.');
        return;
    }

    const exitYear = student.discontinuationDetails?.academicYear || student.academicYear || '';
    const missedYears = getMissedAcademicYears(exitYear, targetYear);
    const preservedDues = calculateStudentPreservedDues(student);

    const confirmMsg = `Confirm Re-admission for:\n\n` +
        `• Student: ${student.name} (Adm: ${student.adm || '--'})\n` +
        `• Target Academic Year: ${targetYear}\n` +
        `• New Class: ${targetClass}\n` +
        `• Return Date: ${formatDateDisplay(returnDate)}\n` +
        `• Missed Years: ${missedYears.length ? missedYears.join(', ') : 'None'}\n` +
        `• Preserved Prior Dues: ₹${preservedDues}\n\n` +
        `The student will become Active in ${targetClass}. Zero fees will be charged for gap years.`;

    if (!confirm(confirmMsg)) return;

    try {
        if (commitBtn) {
            commitBtn.disabled = true;
            commitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Re-admitting...</span>';
        }

        const currentAcademicYearsMap = student.academicYears && typeof student.academicYears === 'object'
            ? { ...student.academicYears }
            : {};

        currentAcademicYearsMap[targetYear] = {
            class: targetClass,
            status: 'Active',
            reAdmittedAt: returnDate,
            notes: readmitNotes
        };

        const currentContinuityLog = Array.isArray(student.continuityLog)
            ? [...student.continuityLog]
            : [];

        currentContinuityLog.unshift({
            id: 'event_' + Date.now(),
            type: 'readmit',
            timestamp: new Date().toISOString(),
            date: returnDate,
            academicYear: targetYear,
            class: targetClass,
            reason: readmitNotes || 'Re-admitted after leave',
            adminEmail: currentAdminEmail || 'Admin',
            gapYears: missedYears,
            priorBalance: preservedDues
        });

        const readmissionDetails = {
            date: returnDate,
            targetYear,
            targetClass,
            reason: readmitNotes || 'Re-admitted after leave',
            gapYears: missedYears,
            recordedBy: currentAdminEmail || 'Admin',
            recordedAt: new Date().toISOString()
        };

        const studentRef = doc(db, `${BASE_PATH}/students`, studentId);
        await updateDoc(studentRef, {
            status: 'Active',
            class: targetClass,
            studentClass: targetClass,
            academicYear: targetYear,
            readmissionDetails,
            academicYears: currentAcademicYearsMap,
            continuityLog: currentContinuityLog,
            updatedAt: new Date().toISOString()
        });

        await syncEnrollmentRecord(studentId, {
            ...student,
            class: targetClass,
            academicYear: targetYear,
            status: 'Active'
        });

        await logAuditEvent({
            category: 'student',
            action: 'student.readmit',
            entityType: 'student',
            entityId: studentId,
            message: `Student re-admitted: ${student.name} (Adm: ${student.adm || '-'}) to Class ${targetClass} in ${targetYear}. Missed gap: ${missedYears.join(', ') || 'None'}.`
        });

        showToast(`Student ${student.name} successfully re-admitted to ${targetClass}!`, 'success');

        document.getElementById('readmission-popup').classList.add('hidden');
        document.getElementById('readmission-popup').classList.remove('flex');

        renderContinuityPage();
        refreshAcademicYearScopedData();

    } catch (err) {
        console.error('Failed to re-admit student:', err);
        alert('Failed to re-admit student: ' + err.message);
    } finally {
        if (commitBtn) {
            commitBtn.disabled = false;
            commitBtn.innerHTML = '<i class="fas fa-user-check"></i> <span>Confirm Re-admission</span>';
        }
    }
};

const openContinuityHistoryModal = (studentId) => {
    const modal = document.getElementById('continuity-history-popup');
    if (!modal) return;

    const student = (rawStudents || []).find(s => s.id === studentId);
    if (!student) {
        alert('Student not found.');
        return;
    }

    document.getElementById('history-student-photo').src = resolveSafePhotoUrl(student.photoUrl || student.photo);
    document.getElementById('history-student-name').textContent = student.name || 'Unknown';
    document.getElementById('history-student-adm').textContent = student.adm || '--';
    document.getElementById('history-student-status').textContent = student.status || 'Active';
    document.getElementById('history-student-guardian').textContent = student.guardian || student.father || '--';
    document.getElementById('history-student-phone').textContent = student.phone || student.mobile || '--';

    const timelineContainer = document.getElementById('continuity-history-timeline');
    const logs = Array.isArray(student.continuityLog) ? student.continuityLog : [];

    if (logs.length === 0) {
        const exitDetails = student.discontinuationDetails;
        if (exitDetails) {
            timelineContainer.innerHTML = `
                <div class="relative pl-6 pb-3 border-l-2 border-rose-400">
                    <span class="absolute -left-2 top-0 w-4 h-4 rounded-full bg-rose-600 border-2 border-white"></span>
                    <div class="font-extrabold text-slate-800">Discontinued</div>
                    <div class="text-[11px] text-slate-500 font-mono">${formatDateDisplay(exitDetails.date)} · ${escapeHtml(exitDetails.academicYear || '')} · Class ${escapeHtml(exitDetails.lastClass || '')}</div>
                    <div class="text-xs text-slate-700 mt-1 italic">"${escapeHtml(exitDetails.reason || 'No notes')}"</div>
                    <div class="text-[10px] text-slate-400 mt-0.5">Recorded by: ${escapeHtml(exitDetails.recordedBy || 'Admin')}</div>
                </div>
            `;
        } else {
            timelineContainer.innerHTML = `
                <div class="p-4 text-center text-slate-400 italic">No continuity transition events recorded yet.</div>
            `;
        }
    } else {
        timelineContainer.innerHTML = logs.map((log) => {
            let dotColor = 'bg-slate-400';
            let borderColor = 'border-slate-200';
            let title = 'Continuity Event';
            let titleColor = 'text-slate-800';
            let icon = 'fa-circle-info';

            const remDues = log.priorBalance !== undefined ? Number(log.priorBalance) : (log.remainingBalance !== undefined ? Number(log.remainingBalance) : null);
            const collected = Number(log.feesCollected || 0);

            if (log.type === 'discontinue') {
                dotColor = 'bg-rose-600';
                borderColor = 'border-rose-300';
                title = 'Student Discontinued (Departure)';
                titleColor = 'text-rose-800';
                icon = 'fa-user-xmark';
            } else if (log.type === 'fee_collection') {
                dotColor = 'bg-blue-600';
                borderColor = 'border-blue-300';
                title = (remDues === 0) ? 'Full Fee Settlement (Cleared)' : 'Fee Collection (Partial Settlement)';
                titleColor = 'text-blue-800';
                icon = 'fa-receipt';
            } else if (log.type === 'readmit') {
                dotColor = 'bg-emerald-600';
                borderColor = 'border-emerald-300';
                title = 'Student Re-admitted (Return)';
                titleColor = 'text-emerald-800';
                icon = 'fa-user-check';
            }

            return `
                <div class="relative pl-6 pb-4 border-l-2 ${borderColor}">
                    <span class="absolute -left-2 top-0.5 w-4 h-4 rounded-full ${dotColor} border-2 border-white shadow-xs"></span>
                    <div class="flex items-center justify-between">
                        <span class="font-extrabold text-xs ${titleColor} flex items-center gap-1.5">
                            <i class="fas ${icon} text-[10px]"></i>
                            ${escapeHtml(title)}
                        </span>
                        <span class="text-[10px] font-mono tabular-nums text-slate-500">${log.date ? formatDateDisplay(log.date) : formatDateDisplay(log.timestamp)}</span>
                    </div>

                    ${log.type === 'fee_collection' ? `
                        <div class="mt-1.5 p-2.5 bg-blue-50/70 border border-blue-200/70 rounded-xl space-y-1">
                            <div class="flex items-center justify-between text-xs font-mono">
                                <span class="text-blue-900 font-bold">Collected: <b class="text-blue-700">₹${collected.toLocaleString('en-IN')}</b></span>
                                <span class="text-slate-600">Receipt: <b>#${log.receiptNo || 'Auto'}</b></span>
                            </div>
                            <div class="flex items-center justify-between text-[11px] font-mono pt-1 border-t border-blue-100">
                                <span class="text-slate-600 font-medium">Remaining Preserved Dues:</span>
                                <span class="font-extrabold ${remDues === 0 ? 'text-emerald-700' : 'text-rose-700'}">₹${(remDues || 0).toLocaleString('en-IN')}</span>
                            </div>
                        </div>
                    ` : `
                        <div class="text-[11px] text-slate-600 font-mono mt-0.5">
                            Year: <b>${escapeHtml(log.academicYear || '--')}</b> · Class: <b>${escapeHtml(log.class || '--')}</b>
                            ${remDues !== null ? ` · Preserved Dues: <b class="text-rose-700">₹${remDues.toLocaleString('en-IN')}</b>` : ''}
                        </div>
                        ${collected > 0 ? `
                            <div class="text-[11px] font-mono text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200/80 mt-1 inline-block">
                                Fees Collected: <b>₹${collected.toLocaleString('en-IN')}</b> (Receipt #${log.receiptNo || 'Auto'})
                            </div>
                        ` : ''}
                    `}

                    ${log.reason ? `<div class="text-xs text-slate-700 mt-1 bg-slate-50 p-2 rounded border border-slate-100 italic">"${escapeHtml(log.reason)}"</div>` : ''}
                    ${Array.isArray(log.gapYears) && log.gapYears.length > 0 ? `<div class="text-[10px] text-emerald-700 mt-1 font-mono">Missed Cycle: ${log.gapYears.join(', ')}</div>` : ''}
                    <div class="text-[10px] text-slate-400 mt-1">Recorded by: ${escapeHtml(log.adminEmail || 'Admin')}</div>
                </div>
            `;
        }).join('');
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

// Wire Continuity Event Listeners
const continuitySearchInput = document.getElementById('continuity-student-search-input');
continuitySearchInput?.addEventListener('input', (e) => {
    filterContinuityStudentSuggestions(e.target.value);
});
continuitySearchInput?.addEventListener('focus', (e) => {
    if (e.target.value.trim()) {
        filterContinuityStudentSuggestions(e.target.value);
    }
});
document.getElementById('continuity-clear-search-btn')?.addEventListener('click', () => {
    clearContinuityStudentSelection();
});
document.getElementById('continuity-class-select')?.addEventListener('change', () => {
    const val = continuitySearchInput?.value || '';
    if (val.trim()) {
        filterContinuityStudentSuggestions(val);
    }
});
document.addEventListener('click', (e) => {
    const container = document.getElementById('continuity-student-search-input')?.closest('.relative');
    if (container && !container.contains(e.target)) {
        document.getElementById('continuity-student-suggestions')?.classList.add('hidden');
    }
});
document.getElementById('continuity-exit-date')?.addEventListener('change', () => {
    if (continuitySelectedStudent) updateContinuityStudentPreview(continuitySelectedStudent.id);
});
document.getElementById('discontinue-student-form')?.addEventListener('submit', handleDiscontinueStudent);
document.getElementById('continuity-search-input')?.addEventListener('input', renderContinuityPage);
document.getElementById('continuity-class-filter')?.addEventListener('change', renderContinuityPage);

document.getElementById('readmit-student-form')?.addEventListener('submit', handleExecuteReadmission);
document.getElementById('readmit-modal-close-btn')?.addEventListener('click', () => {
    document.getElementById('readmission-popup')?.classList.add('hidden');
    document.getElementById('readmission-popup')?.classList.remove('flex');
});
document.getElementById('readmit-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('readmission-popup')?.classList.add('hidden');
    document.getElementById('readmission-popup')?.classList.remove('flex');
});

document.getElementById('continuity-history-close-btn')?.addEventListener('click', () => {
    document.getElementById('continuity-history-popup')?.classList.add('hidden');
    document.getElementById('continuity-history-popup')?.classList.remove('flex');
});
document.getElementById('continuity-history-done-btn')?.addEventListener('click', () => {
    document.getElementById('continuity-history-popup')?.classList.add('hidden');
    document.getElementById('continuity-history-popup')?.classList.remove('flex');
});

// Quick Fee Settlement for Discontinued Students
const updateQuickSettleSelectedTotal = () => {
    const checkedBoxes = Array.from(document.querySelectorAll('.quick-settle-fee-checkbox:checked'));
    const total = checkedBoxes.reduce((sum, cb) => sum + Number(cb.dataset.amount || 0), 0);
    const totalEl = document.getElementById('quick-settle-selected-total');
    if (totalEl) totalEl.textContent = `₹${total.toLocaleString('en-IN')}`;

    const studentId = document.getElementById('quick-settle-student-id')?.value;
    const student = (rawStudents || []).find(s => s.id === studentId);
    const totalPreservedDues = student ? calculateStudentPreservedDues(student) : 0;
    const remainingBalance = Math.max(0, totalPreservedDues - total);

    const remEl = document.getElementById('quick-settle-remaining-balance');
    if (remEl) {
        remEl.textContent = `₹${remainingBalance.toLocaleString('en-IN')}`;
        if (remainingBalance === 0 && total > 0) {
            remEl.className = 'text-base font-extrabold font-mono text-emerald-700 tabular-nums';
        } else {
            remEl.className = 'text-base font-extrabold font-mono text-rose-700 tabular-nums';
        }
    }

    const submitBtn = document.getElementById('quick-settle-submit-btn');
    if (submitBtn) {
        submitBtn.disabled = (total <= 0);
    }

    const container = document.getElementById('quick-settle-items-grid');
    if (container) {
        container.querySelectorAll('.quick-settle-fee-card').forEach(card => {
            const cb = card.querySelector('.quick-settle-fee-checkbox');
            if (cb && cb.checked) {
                card.classList.remove('border-slate-200', 'bg-white', 'opacity-60');
                card.classList.add('border-emerald-500', 'bg-emerald-50/80', 'ring-1', 'ring-emerald-400');
            } else if (cb) {
                card.classList.remove('border-emerald-500', 'bg-emerald-50/80', 'ring-1', 'ring-emerald-400');
                card.classList.add('border-slate-200', 'bg-white', 'opacity-60');
            }
        });
    }
    return total;
};

const openQuickSettleModal = (studentId) => {
    try {
        const modal = document.getElementById('continuity-quick-settle-popup');
        if (!modal) {
            console.error('Modal continuity-quick-settle-popup not found');
            return;
        }

        const student = (rawStudents || []).find(s => s.id === studentId);
        if (!student) {
            alert('Student record not found.');
            return;
        }

        const idInput = document.getElementById('quick-settle-student-id');
        if (idInput) idInput.value = student.id;

        const photoEl = document.getElementById('quick-settle-student-photo');
        if (photoEl) photoEl.src = resolveSafePhotoUrl(student.photoUrl || student.photo);

        const nameEl = document.getElementById('quick-settle-student-name');
        if (nameEl) nameEl.textContent = student.name || 'Unknown';

        const admEl = document.getElementById('quick-settle-student-adm');
        if (admEl) admEl.textContent = student.adm || '--';

        const classEl = document.getElementById('quick-settle-student-class');
        if (classEl) classEl.textContent = student.discontinuationDetails?.lastClass || student.class || '--';

        const preservedDues = calculateStudentPreservedDues(student);
        const duesEl = document.getElementById('quick-settle-student-dues');
        if (duesEl) duesEl.textContent = `₹${preservedDues.toLocaleString('en-IN')}`;

        const receiptInput = document.getElementById('quick-settle-receipt-no');
        if (receiptInput) receiptInput.value = getNextReceiptNo();

        const paymentDateInput = document.getElementById('quick-settle-payment-date');
        if (paymentDateInput) paymentDateInput.value = new Date().toISOString().split('T')[0];

        const notesInput = document.getElementById('quick-settle-notes');
        if (notesInput) notesInput.value = 'Preserved dues settlement';

        const exitDateStr = student.discontinuationDetails?.date || null;
        let pendingItems = getStudentDetailedPendingFees(student, exitDateStr);

        // Fallback for students with preserved lump-sum balance but without individual pending items
        if (pendingItems.length === 0 && preservedDues > 0) {
            pendingItems = [{
                key: 'preserved_dues_balance',
                name: 'Preserved Outstanding Dues',
                type: 'custom',
                amount: preservedDues,
                academicYear: student.discontinuationDetails?.academicYear || getActiveAcademicYearLabel()
            }];
        }

        const container = document.getElementById('quick-settle-items-grid');

        if (!container) return;

        if (pendingItems.length === 0) {
            container.innerHTML = `
                <div class="col-span-full p-4 bg-emerald-50 text-emerald-800 rounded-xl text-xs font-semibold border border-emerald-200 flex items-center justify-center gap-2">
                    <i class="fas fa-check-circle text-emerald-600"></i>
                    <span>All fee items have been completely settled. No outstanding items found.</span>
                </div>
            `;
            updateQuickSettleSelectedTotal();
        } else {
            container.innerHTML = pendingItems.map((item, idx) => `
                <label for="qs-fee-${idx}" class="quick-settle-fee-card flex flex-col justify-between p-2 rounded-lg border border-emerald-500 bg-emerald-50/80 ring-1 ring-emerald-400 shadow-xs cursor-pointer transition select-none hover:shadow-sm" data-idx="${idx}">
                    <div class="flex items-start justify-between gap-1.5">
                        <div class="min-w-0 flex-1">
                            <div class="text-xs font-bold text-slate-900 truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                            <div class="text-[10px] text-slate-500 truncate">${item.type === 'month' ? 'Monthly' : 'Item'} · ${escapeHtml(item.academicYear)}</div>
                        </div>
                        <input type="checkbox" id="qs-fee-${idx}" class="quick-settle-fee-checkbox w-3.5 h-3.5 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 shrink-0 mt-0.5"
                               data-key="${escapeHtml(item.key)}" data-type="${escapeHtml(item.type)}" data-amount="${item.amount}" data-name="${escapeHtml(item.name)}" data-year="${escapeHtml(item.academicYear)}" checked>
                    </div>
                    <div class="mt-1.5 pt-1 border-t border-slate-200/60 flex items-center justify-between">
                        <span class="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Fee</span>
                        <span class="text-xs font-extrabold font-mono tabular-nums text-emerald-800">₹${Number(item.amount).toLocaleString('en-IN')}</span>
                    </div>
                </label>
            `).join('');

            container.querySelectorAll('.quick-settle-fee-checkbox').forEach(cb => {
                cb.addEventListener('change', updateQuickSettleSelectedTotal);
            });
            updateQuickSettleSelectedTotal();
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    } catch (err) {
        console.error('Failed to open quick fee settlement modal:', err);
        alert('Could not open fee collection window.');
    }
};

const closeQuickSettleModal = () => {
    const modal = document.getElementById('continuity-quick-settle-popup');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

const handleQuickSettleSubmit = async (e) => {
    e.preventDefault();
    if (!requirePermission('fees.manage')) return;

    const studentId = document.getElementById('quick-settle-student-id')?.value;
    const student = (rawStudents || []).find(s => s.id === studentId);
    if (!student) {
        alert('Student record not found.');
        return;
    }

    const checkedBoxes = Array.from(document.querySelectorAll('.quick-settle-fee-checkbox:checked'));
    if (checkedBoxes.length === 0) {
        alert('Please select at least one fee item to collect.');
        return;
    }

    const itemsToCollect = checkedBoxes.map(cb => ({
        key: cb.dataset.key,
        name: cb.dataset.name,
        type: cb.dataset.type,
        amount: Number(cb.dataset.amount || 0),
        academicYear: cb.dataset.year || getActiveAcademicYearLabel()
    }));

    const totalCollected = itemsToCollect.reduce((sum, it) => sum + it.amount, 0);
    const rcptVal = (document.getElementById('quick-settle-receipt-no')?.value || '').trim();
    const receiptNo = rcptVal ? parseInt(rcptVal, 10) : null;
    const paymentDate = document.getElementById('quick-settle-payment-date')?.value || new Date().toISOString().split('T')[0];
    const paymentMode = document.getElementById('quick-settle-payment-mode')?.value || 'Cash';
    const paymentDesc = (document.getElementById('quick-settle-notes')?.value || '').trim() || 'Preserved dues settlement';
    const submitBtn = document.getElementById('quick-settle-submit-btn');

    const currentPreservedDues = calculateStudentPreservedDues(student);
    const newPreservedDues = Math.max(0, currentPreservedDues - totalCollected);

    const confirmMsg = `Confirm collecting fee payment:\n\n` +
        `• Student: ${student.name} (Adm: ${student.adm || '--'})\n` +
        `• Total Amount to Collect: ₹${totalCollected.toLocaleString('en-IN')}\n` +
        `• Remaining Preserved Dues: ₹${newPreservedDues.toLocaleString('en-IN')}\n` +
        `• Receipt No: ${receiptNo || 'Auto'}\n` +
        `• Payment Mode: ${paymentMode}\n` +
        `• Date: ${formatDateDisplay(paymentDate)}\n\n` +
        `Proceed with payment entry?`;

    if (!confirm(confirmMsg)) return;

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Processing...</span>';
        }

        const batch = writeBatch(db);
        const txnId = `TXN_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const collectorKey = currentAdminEmail || 'admin';
        const collectorName = currentAdminEmail || 'Administrator';
        const activeYear = getActiveAcademicYearLabel();
        const lastClass = student.discontinuationDetails?.lastClass || student.class || '';

        const createdPayments = [];

        itemsToCollect.forEach(item => {
            const paymentPayload = {
                receiptNo: receiptNo,
                transactionId: txnId,
                paymentDate: paymentDate,
                paymentMode: paymentMode,
                timestamp: Date.now(),
                description: paymentDesc,
                collectedBy: collectorKey,
                collectedByName: collectorName,
                academicYear: item.academicYear || activeYear,
                classLabel: lastClass,
                studentId: student.id,
                admissionNo: student.adm || '',
                studentName: student.name || '',
                itemKey: item.key,
                amount: item.amount,
                billingGroupId: null
            };

            const paymentRef = doc(collection(db, `${BASE_PATH}/payments`));
            batch.set(paymentRef, paymentPayload);
            const yearPath = `${BASE_PATH}/academicYears/${toAcademicYearDocId(item.academicYear || activeYear)}/payments`;
            batch.set(doc(db, yearPath, paymentRef.id), paymentPayload);
            createdPayments.push({ id: paymentRef.id, ...paymentPayload });
        });

        const currentContinuityLog = Array.isArray(student.continuityLog)
            ? [...student.continuityLog]
            : [];

        currentContinuityLog.unshift({
            id: 'event_' + Date.now(),
            type: 'fee_collection',
            timestamp: new Date().toISOString(),
            date: paymentDate,
            academicYear: activeYear,
            class: lastClass,
            reason: paymentDesc,
            adminEmail: currentAdminEmail || 'Admin',
            feesCollected: totalCollected,
            receiptNo: receiptNo,
            priorBalance: newPreservedDues,
            remainingBalance: newPreservedDues
        });

        const studentRef = doc(db, `${BASE_PATH}/students`, student.id);
        const updatePayload = {
            'discontinuationDetails.preservedDues': newPreservedDues,
            continuityLog: currentContinuityLog,
            updatedAt: new Date().toISOString()
        };
        batch.update(studentRef, updatePayload);

        await batch.commit();

        // Update local memory
        allPayments.push(...createdPayments);
        if (student.discontinuationDetails) {
            student.discontinuationDetails.preservedDues = newPreservedDues;
        }
        student.continuityLog = currentContinuityLog;

        await logAuditEvent({
            category: 'fee',
            action: 'payment.create',
            entityType: 'payment',
            entityId: txnId,
            message: `Collected ₹${totalCollected} for discontinued student ${student.name} (Adm: ${student.adm || '-'}). Remaining: ₹${newPreservedDues}. Receipt: ${receiptNo || '-'}.`
        });

        closeQuickSettleModal();
        renderContinuityPage();
        alert(`Payment of ₹${totalCollected.toLocaleString('en-IN')} recorded successfully!${newPreservedDues > 0 ? ` Remaining preserved balance: ₹${newPreservedDues.toLocaleString('en-IN')}.` : ' All dues have been cleared.'}`);
    } catch (err) {
        console.error('Failed to process quick fee settlement:', err);
        alert('Failed to save fee collection. Please check your connection and try again.');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-check-circle"></i> <span>Collect &amp; Save Payment</span>';
        }
    }
};

document.getElementById('quick-settle-close-btn')?.addEventListener('click', closeQuickSettleModal);
document.getElementById('quick-settle-cancel-btn')?.addEventListener('click', closeQuickSettleModal);
document.getElementById('quick-settle-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.quick-settle-fee-checkbox').forEach(cb => cb.checked = true);
    updateQuickSettleSelectedTotal();
});
document.getElementById('quick-settle-deselect-all')?.addEventListener('click', () => {
    document.querySelectorAll('.quick-settle-fee-checkbox').forEach(cb => cb.checked = false);
    updateQuickSettleSelectedTotal();
});
document.getElementById('quick-settle-form')?.addEventListener('submit', handleQuickSettleSubmit);

// --- 4. MANAGE CLASSES ---
const renderClassList = () => {
    const cont = document.getElementById('class-list-container');
    if(classes.length === 0) { cont.innerHTML = '<p class="text-gray-500">No classes found for the active academic year yet.</p>'; return; }
    cont.innerHTML = classes.map(c => `<div class="flex justify-between items-center bg-white shadow-sm border border-gray-200 p-4 rounded-xl"><span class="font-bold text-gray-800 text-lg">${escapeHtml(c)}</span><div><button class="bg-blue-50 text-blue-600 hover:bg-blue-100 p-2 rounded-lg mr-2 edit-class-btn transition" data-class="${escapeHtml(c)}"><i class="fas fa-edit"></i></button><button class="bg-red-50 text-red-600 hover:bg-red-100 p-2 rounded-lg delete-class-btn transition" data-class="${escapeHtml(c)}"><i class="fas fa-trash"></i></button></div></div>`).join('');

    document.getElementById('move-from-class').innerHTML = `<option value="">-- Select --</option>` + classes.map(c=>`<option value="${c}">${c}</option>`).join('');
    document.getElementById('move-target-sel').innerHTML = classes.map(c=>`<option value="${c}">${c}</option>`).join('');
};
document.getElementById('create-class-btn').addEventListener('click', async () => {
    if(!requirePermission('classes.manage')) return;
    const className = document.getElementById('new-class-name-input').value.trim().toUpperCase();
    if(!className) return alert('Enter a class/division name.');
    if(classes.includes(className)) return alert('This class/division already exists in the active academic year.');
    await syncActiveAcademicYearClasses([className]);
    await logAuditEvent({ category: 'class', action: 'class.create', entityType: 'class', entityId: className, message: `Class created: ${className}.` });
    document.getElementById('new-class-name-input').value = '';
    alert('Class/division created successfully.');
});
document.getElementById('generate-default-classes-btn')?.addEventListener('click', async () => {
    if(!requirePermission('classes.manage')) return;
    if(!confirm('Reset active year classes to default ladder (1 to 12)?')) return;
    await syncActiveAcademicYearClasses(getDefaultClassLadder(), { replace: true });
    await logAuditEvent({ category: 'class', action: 'class.default.generate', entityType: 'academicYear', entityId: getActiveAcademicYearLabel(), message: 'Default class ladder generated (1 to 12).' });
});
document.getElementById('create-divisions-btn')?.addEventListener('click', async () => {
    if(!requirePermission('classes.manage')) return;
    const baseClass = document.getElementById('division-base-class-input')?.value || '';
    const divisionCount = document.getElementById('division-count-input')?.value || 3;
    const labels = buildDivisionLabels(baseClass, divisionCount);
    if (!labels.length) return alert('Enter a valid base class for divisions.');
    await syncActiveAcademicYearClasses([...classes, ...labels]);
    await logAuditEvent({ category: 'class', action: 'class.divisions.create', entityType: 'class', entityId: baseClass, message: `Created ${labels.length} division classes for ${baseClass}.`, metadata: { labels } });
});
document.getElementById('class-list-container').addEventListener('click', e => {
    const editBtn = e.target.closest('.edit-class-btn'), delBtn = e.target.closest('.delete-class-btn');
    if(editBtn) {
        if(!requirePermission('students.manage')) return; if(!requirePermission('classes.manage')) return; editingClassName = editBtn.dataset.class; document.getElementById('edit-class-name').value = editingClassName; document.getElementById('edit-class-popup').classList.remove('hidden'); document.getElementById('edit-class-popup').classList.add('flex'); }
    if(delBtn) {
        if(!requirePermission('classes.manage')) return;
        const cName = delBtn.dataset.class;
        if(!confirm(`Permanently delete class '${cName}'? Enrolled students in this class will also be deleted.`)) return;
        const toDelete = students.filter(s => s.class === cName).map(s => s.id);
        deleteStudentsAndDependencies(toDelete)
            .then(async () => {
                await removeClassFromActiveAcademicYear(cName);
                await logAuditEvent({ category: 'class', action: 'class.delete', entityType: 'class', entityId: cName, message: `Class deleted: ${cName}.`, metadata: { deletedStudents: toDelete.length } });
                alert('Class deleted.');
            })
            .catch((error) => {
                console.error('Failed to delete class dependencies.', error);
                alert('Failed to delete the class completely. Please try again.');
            });
    }
});
document.getElementById('edit-class-cancel').addEventListener('click', () => document.getElementById('edit-class-popup').classList.add('hidden'));
document.getElementById('edit-class-update').addEventListener('click', async () => {
    if(!requirePermission('classes.manage')) return;
    const newName = document.getElementById('edit-class-name').value.trim().toUpperCase();
    if(newName && newName !== editingClassName) {
        if(!confirm("Rename class?")) return;
        const batch = writeBatch(db); students.filter(s => s.class === editingClassName).forEach(s => { batch.update(doc(db, `${BASE_PATH}/students`, s.id), { class: newName }); });
        await batch.commit();
        await syncActiveAcademicYearClasses(classes.map((className) => className === editingClassName ? newName : className), { replace: true });
        await logAuditEvent({ category: 'class', action: 'class.rename', entityType: 'class', entityId: editingClassName, message: `Class renamed from ${editingClassName} to ${newName}.` });
        document.getElementById('edit-class-popup').classList.add('hidden');
    }
});

const moveListCont = document.getElementById('move-student-list-container');
const moveBtn = document.getElementById('move-selected-students-btn');
const moveBoysList = document.getElementById('move-boys-list');
const moveGirlsList = document.getElementById('move-girls-list');
const moveBoysCount = document.getElementById('move-boys-count');
const moveGirlsCount = document.getElementById('move-girls-count');
const moveAllBoys = document.getElementById('move-all-boys');
const moveAllGirls = document.getElementById('move-all-girls');
const moveSelectedBadge = document.getElementById('move-selected-badge');
const moveSelectedCount = document.getElementById('move-selected-count');
let editGroupWorkingMembers = [];

const updateMoveSelectionUI = () => {
    const checkedCount = document.querySelectorAll('.move-chk:checked').length;
    const boysTotal = document.querySelectorAll('.move-chk-boy').length;
    const boysChecked = document.querySelectorAll('.move-chk-boy:checked').length;
    const girlsTotal = document.querySelectorAll('.move-chk-girl').length;
    const girlsChecked = document.querySelectorAll('.move-chk-girl:checked').length;

    if (moveAllBoys) moveAllBoys.checked = boysTotal > 0 && boysChecked === boysTotal;
    if (moveAllGirls) moveAllGirls.checked = girlsTotal > 0 && girlsChecked === girlsTotal;

    if (moveBtn) {
        moveBtn.disabled = checkedCount === 0;
        moveBtn.innerHTML = `<i class="fas fa-arrow-right-arrow-left mr-1"></i> Move Students${checkedCount > 0 ? ` (${checkedCount})` : ''}`;
    }
    if (moveSelectedBadge) {
        moveSelectedBadge.classList.toggle('hidden', checkedCount === 0);
    }
    if (moveSelectedCount) {
        moveSelectedCount.textContent = checkedCount;
    }
};

document.getElementById('move-from-class').addEventListener('change', (e) => {
    const cName = (e.target.value || '').trim();
    if (!cName) {
        if (moveListCont) moveListCont.classList.add('hidden');
        if (moveBoysList) moveBoysList.innerHTML = '';
        if (moveGirlsList) moveGirlsList.innerHTML = '';
        updateMoveSelectionUI();
        return;
    }

    const inClass = students.filter(s => s.class === cName);
    const boys = inClass.filter(s => (s.gender || 'Male').toLowerCase().startsWith('m')).sort((a,b)=>a.name.localeCompare(b.name));
    const girls = inClass.filter(s => (s.gender || '').toLowerCase().startsWith('f')).sort((a,b)=>a.name.localeCompare(b.name));

    if (moveBoysCount) moveBoysCount.textContent = boys.length;
    if (moveGirlsCount) moveGirlsCount.textContent = girls.length;
    if (moveAllBoys) moveAllBoys.checked = false;
    if (moveAllGirls) moveAllGirls.checked = false;

    if (moveBoysList) {
        moveBoysList.innerHTML = boys.length === 0
            ? '<p class="text-xs text-slate-400 italic py-4 text-center">No boys found in this class.</p>'
            : boys.map(s => `
                <label class="flex items-center justify-between p-2 rounded-lg border border-blue-100 bg-white hover:bg-blue-50/70 transition cursor-pointer select-none shadow-xs">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <input type="checkbox" class="move-chk move-chk-boy w-4 h-4 rounded text-blue-600 focus:ring-blue-500" value="${escapeHtml(s.id)}" id="m-${escapeHtml(s.id)}">
                        <span class="text-xs font-bold text-slate-800 truncate">${escapeHtml(s.name)}</span>
                    </div>
                    <span class="text-[11px] font-semibold text-slate-500 font-mono shrink-0 ml-2">Adm: ${escapeHtml(s.adm || '-')}</span>
                </label>
            `).join('');
    }

    if (moveGirlsList) {
        moveGirlsList.innerHTML = girls.length === 0
            ? '<p class="text-xs text-slate-400 italic py-4 text-center">No girls found in this class.</p>'
            : girls.map(s => `
                <label class="flex items-center justify-between p-2 rounded-lg border border-rose-100 bg-white hover:bg-rose-50/70 transition cursor-pointer select-none shadow-xs">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <input type="checkbox" class="move-chk move-chk-girl w-4 h-4 rounded text-rose-600 focus:ring-rose-500" value="${escapeHtml(s.id)}" id="m-${escapeHtml(s.id)}">
                        <span class="text-xs font-bold text-slate-800 truncate">${escapeHtml(s.name)}</span>
                    </div>
                    <span class="text-[11px] font-semibold text-slate-500 font-mono shrink-0 ml-2">Adm: ${escapeHtml(s.adm || '-')}</span>
                </label>
            `).join('');
    }

    if (moveListCont) moveListCont.classList.remove('hidden');
    updateMoveSelectionUI();
});

moveAllBoys?.addEventListener('change', (e) => {
    document.querySelectorAll('.move-chk-boy').forEach(c => c.checked = e.target.checked);
    updateMoveSelectionUI();
});

moveAllGirls?.addEventListener('change', (e) => {
    document.querySelectorAll('.move-chk-girl').forEach(c => c.checked = e.target.checked);
    updateMoveSelectionUI();
});

moveListCont?.addEventListener('change', (e) => {
    if (e.target.classList.contains('move-chk')) {
        updateMoveSelectionUI();
    }
});

document.querySelectorAll('input[name="move_dest_type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        if(e.target.value === 'existing') {
            document.getElementById('move-target-sel')?.classList.remove('hidden');
            document.getElementById('move-target-inp')?.classList.add('hidden');
        } else {
            document.getElementById('move-target-sel')?.classList.add('hidden');
            document.getElementById('move-target-inp')?.classList.remove('hidden');
        }
    });
});

moveBtn.addEventListener('click', async () => {
    if(!requirePermission('classes.manage')) return;
    const ids = Array.from(document.querySelectorAll('.move-chk:checked')).map(c=>c.value);
    const isNew = document.querySelector('input[name="move_dest_type"]:checked')?.value === 'new';
    const targetClass = isNew
        ? (document.getElementById('move-target-inp')?.value || '').trim().toUpperCase()
        : (document.getElementById('move-target-sel')?.value || '').trim();

    if(!ids.length) return alert("Please select at least one student to move.");
    if(!targetClass) return alert("Please specify the target class.");
    if(!confirm(`Move ${ids.length} selected student(s) to class ${targetClass}?`)) return;

    try {
        moveBtn.disabled = true;
        moveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Moving...';
        const batch = writeBatch(db);
        ids.forEach((id) => {
            batch.update(doc(db, `${BASE_PATH}/students`, id), { class: targetClass });
            const student = rawStudents.find((entry) => entry.id === id);
            batch.set(
                getEnrollmentRef(student?.academicYear || currentAcademicYear, id),
                buildEnrollmentPayload(id, { ...(student || {}), class: targetClass }),
                { merge: true }
            );
        });
        await batch.commit();
        await syncActiveAcademicYearClasses([targetClass]);
        await logAuditEvent({
            category: 'class',
            action: 'student.move',
            entityType: 'student',
            message: `Moved ${ids.length} students to ${targetClass}.`,
            metadata: { targetClass, ids }
        });
        alert(`Successfully moved ${ids.length} student(s) to class ${targetClass}.`);
        document.getElementById('move-from-class').value = '';
        if (moveListCont) moveListCont.classList.add('hidden');
        updateMoveSelectionUI();
    } catch (err) {
        console.error("Move students error:", err);
        alert("Error moving students: " + err.message);
    } finally {
        moveBtn.disabled = false;
        updateMoveSelectionUI();
    }
});

// --- 5. GROUPS ---
const getStudentDisplayLabel = (student) => `${student?.name || '-'} (${student?.class || '--'}${student?.adm ? ` • Adm: ${student.adm}` : ''})`;
const getGroupStudentOptions = (className, gender, excludedIds = []) => students
    .filter((student) => student.class === className && student.gender === gender && !excludedIds.includes(student.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
const findStudentFromTypedGroupValue = (value, className, gender, excludedIds = []) => {
    const normalizedValue = (value || '').trim().toLowerCase();
    if(!normalizedValue) return null;
    return getGroupStudentOptions(className, gender, excludedIds).find((student) => {
        const label = getStudentDisplayLabel(student).toLowerCase();
        return student.id === value || label === normalizedValue || (student.name || '').trim().toLowerCase() === normalizedValue;
    }) || null;
};
const renderGroupStudentDatalist = (idx) => {
    const className = document.querySelector(`.grp-cls[data-idx="${idx}"]`)?.value || '';
    const gender = document.querySelector(`.grp-gen[data-idx="${idx}"]`)?.value || '';
    const datalist = document.getElementById(`grp-stu-options-${idx}`);
    const input = document.getElementById(`grp-stu-${idx}`);
    if(!datalist || !input) return;
    if(!className || !gender) {
        datalist.innerHTML = '';
        input.value = '';
        input.placeholder = 'Select class and gender first...';
        return;
    }
    datalist.innerHTML = getGroupStudentOptions(className, gender)
        .map((student) => `<option value="${escapeHtml(getStudentDisplayLabel(student))}"></option>`)
        .join('');
    input.placeholder = 'Type student name...';
};
const renderStudentGroups = () => {
    const listNode = document.getElementById('student-groups-list');
    if (!listNode) return;
    // Deduplicate groups by unique ID to prevent any duplicate card display
    const uniqueGroups = Array.from(new Map((studentGroups || []).map((g) => [g.id, g])).values());
    listNode.innerHTML = uniqueGroups.length === 0 ? '<p class="text-gray-500 italic p-3">No groups created yet.</p>' : uniqueGroups.map((g) => {
        const memberCards = (g.memberIds || []).map((memberId) => {
            const student = students.find((entry) => entry.id === memberId);
            if(!student) return `<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-100 text-xs font-bold">Missing student</span>`;
            return `<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-50 text-slate-700 border border-slate-200 text-xs font-bold">${escapeHtml(student.name || '-')} <span class="ml-1 text-slate-500">(${escapeHtml(student.class || '--')})</span></span>`;
        }).join('');
        return `<div class="bg-white border border-gray-200 p-4 rounded-xl shadow-sm flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-3"><div class="flex flex-col gap-2"><div class="flex flex-wrap gap-2">${memberCards}</div><span class="text-gray-500 text-sm font-medium"><i class="fas fa-users mr-1"></i> ${(g.memberIds || []).length} Linked Students ${g.fee > 0 ? `<span class="ml-2 text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-bold">₹${g.fee}/month</span>` : ''}</span></div><div class="shrink-0"><button class="text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-2 rounded-lg text-sm font-bold transition edit-grp mr-2" data-id="${g.id}"><i class="fas fa-edit"></i> Edit</button><button class="text-red-600 bg-red-50 hover:bg-red-100 px-3 py-2 rounded-lg text-sm font-bold transition del-grp" data-id="${g.id}"><i class="fas fa-trash"></i></button></div></div>`;
    }).join('');
};
const renderEditGroupMembers = () => {
    const membersNode = document.getElementById('e-grp-members');
    membersNode.innerHTML = editGroupWorkingMembers.length
        ? editGroupWorkingMembers.map((sid) => {
            const s = students.find((st) => st.id === sid);
            if(!s) return '';
            return `<div class="flex items-center justify-between bg-white border border-gray-200 px-2 py-1.5 rounded">
                <span class="text-sm font-medium text-gray-700">${escapeHtml(s.name || '-')} <span class="text-xs text-gray-500">(${escapeHtml(s.class || '--')})</span></span>
                <button class="text-red-600 hover:text-red-800 text-xs font-bold e-grp-remove-member" data-id="${s.id}"><i class="fas fa-times mr-1"></i>Remove</button>
            </div>`;
        }).join('')
        : '<p class="text-sm italic text-gray-500">No members in this group.</p>';
};
const populateEditGroupClassFilter = () => {
    const classFilter = document.getElementById('e-grp-class-filter');
    classFilter.innerHTML = '<option value="">Select Class</option>' + classes.map((c) => `<option value="${c}">${c}</option>`).join('');
};
const populateEditGroupStudentOptions = () => {
    const cls = document.getElementById('e-grp-class-filter').value;
    const gen = document.getElementById('e-grp-gender-filter').value;
    const studentInput = document.getElementById('e-grp-student-select');
    const studentOptions = document.getElementById('e-grp-student-options');
    if(!studentInput || !studentOptions) return;
    if(!cls) {
        studentInput.value = '';
        studentInput.placeholder = 'Select class first...';
        studentOptions.innerHTML = '';
        return;
    }
    studentOptions.innerHTML = getGroupStudentOptions(cls, gen, editGroupWorkingMembers)
        .map((student) => `<option value="${escapeHtml(getStudentDisplayLabel(student))}"></option>`)
        .join('');
    studentInput.placeholder = 'Type student name...';
};
document.getElementById('student-groups-list').addEventListener('click', e => {
    const delBtn = e.target.closest('.del-grp'), editBtn = e.target.closest('.edit-grp');
    if(delBtn) {
        if(!requirePermission('groups.manage')) return;
        if(!confirm("Permanently delete this student group?")) return;
        deleteDoc(doc(db, `${BASE_PATH}/studentGroups`, delBtn.dataset.id));
        studentGroups = studentGroups.filter((g) => g.id !== delBtn.dataset.id);
        renderStudentGroups();
        logAuditEvent({ category: 'group', action: 'group.delete', entityType: 'studentGroup', entityId: delBtn.dataset.id, message: 'Student group deleted.' });
    }
    if(editBtn) {
        if(!requirePermission('groups.manage')) return;
        const g = studentGroups.find(gr => gr.id === editBtn.dataset.id);
        if(g) {
            document.getElementById('e-grp-id').value = g.id; document.getElementById('e-grp-fee').value = g.fee || '';
            editGroupWorkingMembers = [...g.memberIds];
            populateEditGroupClassFilter();
            renderEditGroupMembers();
            populateEditGroupStudentOptions();
            document.getElementById('edit-group-popup').classList.remove('hidden'); document.getElementById('edit-group-popup').classList.add('flex');
        }
    }
});
document.getElementById('edit-group-cancel').onclick = () => document.getElementById('edit-group-popup').classList.add('hidden');
document.getElementById('e-grp-class-filter').addEventListener('change', () => { document.getElementById('e-grp-student-select').value = ''; populateEditGroupStudentOptions(); });
document.getElementById('e-grp-gender-filter').addEventListener('change', () => { document.getElementById('e-grp-student-select').value = ''; populateEditGroupStudentOptions(); });
document.getElementById('e-grp-add-member').addEventListener('click', () => {
    const studentInput = document.getElementById('e-grp-student-select');
    const cls = document.getElementById('e-grp-class-filter').value;
    const gen = document.getElementById('e-grp-gender-filter').value;
    const studentId = findStudentFromTypedGroupValue(studentInput.value, cls, gen, editGroupWorkingMembers)?.id || '';
    if(!studentId || editGroupWorkingMembers.includes(studentId)) return alert('Please select a valid student from the suggestions.');
    editGroupWorkingMembers.push(studentId);
    studentInput.value = '';
    renderEditGroupMembers();
    populateEditGroupStudentOptions();
});
document.getElementById('e-grp-members').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.e-grp-remove-member');
    if(!removeBtn) return;
    editGroupWorkingMembers = editGroupWorkingMembers.filter((id) => id !== removeBtn.dataset.id);
    renderEditGroupMembers();
    populateEditGroupStudentOptions();
});
document.getElementById('edit-group-update').onclick = async () => {
    if(!requirePermission('groups.manage')) return;
    const gid = document.getElementById('e-grp-id').value;
    const feeInput = document.getElementById('e-grp-fee');
    const feeVal = feeInput?.value?.trim();
    const gfee = parseFloat(feeVal);
    const newMem = [...editGroupWorkingMembers];

    if(newMem.length === 0) {
        if(!confirm("Remove all members and delete this student group?")) return;
        await deleteDoc(doc(db, `${BASE_PATH}/studentGroups`, gid));
        studentGroups = studentGroups.filter((g) => g.id !== gid);
        renderStudentGroups();
        await logAuditEvent({ category: 'group', action: 'group.delete', entityType: 'studentGroup', entityId: gid, message: 'Student group removed during edit.' });
        document.getElementById('edit-group-popup').classList.add('hidden');
        return;
    }

    if(newMem.length < 2) return alert("Group must have at least 2 members. Add more or delete group.");

    if(!feeVal || isNaN(gfee) || gfee <= 0) {
        alert("Group Monthly Fee is mandatory. Please enter a valid fee amount.");
        feeInput?.focus();
        return;
    }

    document.getElementById('edit-group-popup').classList.add('hidden');
    openUnifyFamilyModal({
        isEdit: true,
        groupId: gid,
        studentIds: newMem,
        groupFee: gfee
    });
};

document.getElementById('num-of-students-group').addEventListener('input', e => {
    const count = parseInt(e.target.value) || 0; const cont = document.getElementById('group-creation-container'); cont.innerHTML = '';
    document.getElementById('create-group-btn-container').classList.toggle('hidden', count < 2);
    if(count < 2) return;
    const clsOpts = `<option value="">Select Class</option>` + classes.map(c=>`<option value="${c}">${c}</option>`).join('');
    for(let i=0; i<count; i++) {
        cont.innerHTML += `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-4 border-b border-gray-100 mb-2"><select class="grp-cls p-2.5 border rounded-lg bg-gray-50 text-sm font-semibold" data-idx="${i}">${clsOpts}</select><select class="grp-gen p-2.5 border rounded-lg bg-gray-50 text-sm font-semibold" data-idx="${i}"><option value="Male">Male</option><option value="Female">Female</option></select><div class="sm:col-span-3"><input id="grp-stu-${i}" list="grp-stu-options-${i}" class="grp-stu p-2.5 border rounded-lg text-sm font-semibold bg-white w-full" data-idx="${i}" autocomplete="off" placeholder="Select class and gender first..."><datalist id="grp-stu-options-${i}"></datalist><p class="text-xs text-gray-500 mt-1">Type a student name and pick from suggestions.</p></div></div>`;
    }
});
document.getElementById('group-creation-container').addEventListener('change', e => {
    if(e.target.classList.contains('grp-cls') || e.target.classList.contains('grp-gen')) {
        const idx = e.target.dataset.idx;
        const input = document.getElementById(`grp-stu-${idx}`);
        if(input) input.value = '';
        renderGroupStudentDatalist(idx);
    }
});
let pendingGroupCreationData = null;

const closeUnifyFamilyModal = () => {
    const modal = document.getElementById('group-unify-family-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    pendingGroupCreationData = null;
};

const openUnifyFamilyModal = (creationData) => {
    const modal = document.getElementById('group-unify-family-modal');
    const listContainer = document.getElementById('unify-family-members-list');
    const skipCheckbox = document.getElementById('unify-family-skip-checkbox');
    const confirmBtn = document.getElementById('unify-family-confirm-btn');
    if (!modal || !listContainer) return;

    pendingGroupCreationData = creationData;
    const { studentIds, isEdit } = creationData;

    const groupStudents = studentIds.map(id =>
        (rawStudents || []).find(s => s.id === id) || (students || []).find(s => s.id === id)
    ).filter(Boolean);

    if (groupStudents.length < 2) {
        alert("Could not load member details for unification.");
        return;
    }

    if (skipCheckbox) skipCheckbox.checked = false;
    if (confirmBtn) {
        confirmBtn.innerHTML = isEdit
            ? '<i class="fas fa-check-circle"></i> <span>Confirm &amp; Update Group</span>'
            : '<i class="fas fa-check-circle"></i> <span>Confirm &amp; Save Group</span>';
    }

    listContainer.innerHTML = groupStudents.map((st, idx) => {
        const fatherName = st.father || st.profile?.father || '--';
        const fatherMobile = st.mobile || st.phone || st.profile?.mobile || '--';
        const motherName = st.mother || st.profile?.mother || '--';
        const motherMobile = st.motherMobile || st.profile?.motherMobile || '--';
        const address = st.address || st.profile?.address || '--';
        const className = st.class || st.studentClass || '--';
        const adm = st.adm || '--';
        const isChecked = (idx === 0);

        return `
            <label class="unify-student-card block p-3.5 rounded-xl border ${isChecked ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-400' : 'border-slate-200 bg-white'} hover:border-blue-300 transition cursor-pointer relative select-none">
                <div class="flex items-start gap-3">
                    <input type="radio" name="unify-primary-student" value="${st.id}" class="unify-primary-radio mt-1 w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-500 shrink-0" ${isChecked ? 'checked' : ''}>
                    <div class="flex-1 min-w-0">
                        <div class="flex flex-wrap items-center justify-between gap-1 pb-1.5 border-b border-slate-100">
                            <div class="font-extrabold text-sm text-slate-900">${escapeHtml(st.name)}</div>
                            <div class="text-xs text-slate-500 font-mono">
                                <span>Adm: <b class="text-slate-700">${escapeHtml(adm)}</b></span> · 
                                <span>Class: <b class="text-slate-700">${escapeHtml(className)}</b></span>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 mt-2 text-xs">
                            <div>
                                <span class="text-slate-500 font-medium">Father:</span>
                                <span class="font-bold text-slate-800 ml-1">${escapeHtml(fatherName)}</span>
                            </div>
                            <div>
                                <span class="text-slate-500 font-medium">Father Phone:</span>
                                <span class="font-bold font-mono text-slate-800 ml-1">${escapeHtml(fatherMobile)}</span>
                            </div>
                            <div>
                                <span class="text-slate-500 font-medium">Mother:</span>
                                <span class="font-bold text-slate-800 ml-1">${escapeHtml(motherName)}</span>
                            </div>
                            <div>
                                <span class="text-slate-500 font-medium">Mother Phone:</span>
                                <span class="font-bold font-mono text-slate-800 ml-1">${escapeHtml(motherMobile)}</span>
                            </div>
                            <div class="sm:col-span-2">
                                <span class="text-slate-500 font-medium">Address:</span>
                                <span class="font-medium text-slate-800 ml-1">${escapeHtml(address)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </label>
        `;
    }).join('');

    const updateCardVisuals = () => {
        const isSkipped = skipCheckbox?.checked;
        listContainer.querySelectorAll('.unify-student-card').forEach(card => {
            const radio = card.querySelector('.unify-primary-radio');
            if (isSkipped) {
                radio.disabled = true;
                card.classList.remove('border-blue-500', 'bg-blue-50/70', 'ring-1', 'ring-blue-400');
                card.classList.add('border-slate-200', 'bg-slate-50/50', 'opacity-60');
            } else {
                radio.disabled = false;
                if (radio && radio.checked) {
                    card.classList.remove('border-slate-200', 'bg-white', 'bg-slate-50/50', 'opacity-60');
                    card.classList.add('border-blue-500', 'bg-blue-50/70', 'ring-1', 'ring-blue-400');
                } else {
                    card.classList.remove('border-blue-500', 'bg-blue-50/70', 'ring-1', 'ring-blue-400', 'bg-slate-50/50', 'opacity-60');
                    card.classList.add('border-slate-200', 'bg-white');
                }
            }
        });
    };

    listContainer.querySelectorAll('.unify-primary-radio').forEach(r => {
        r.addEventListener('change', updateCardVisuals);
    });

    if (skipCheckbox) {
        skipCheckbox.onchange = updateCardVisuals;
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

const handleConfirmGroupCreation = async () => {
    if (!requirePermission('groups.manage')) return;
    if (!pendingGroupCreationData) return;

    const { studentIds, groupFee, isEdit, groupId } = pendingGroupCreationData;
    const modal = document.getElementById('group-unify-family-modal');
    const confirmBtn = document.getElementById('unify-family-confirm-btn');
    const skipCheckbox = document.getElementById('unify-family-skip-checkbox');

    const groupStudents = studentIds.map(id =>
        (rawStudents || []).find(s => s.id === id) || (students || []).find(s => s.id === id)
    ).filter(Boolean);

    const isSkipped = !!skipCheckbox?.checked;
    let chosenStudent = null;

    if (!isSkipped) {
        const chosenId = modal?.querySelector('input[name="unify-primary-student"]:checked')?.value;
        chosenStudent = groupStudents.find(s => s.id === chosenId) || groupStudents[0];
    }

    try {
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Saving...</span>';
        }

        const batch = writeBatch(db);
        const nowTs = Date.now();

        // 1. If unifying family details, batch update each student in the group
        if (chosenStudent) {
            const father = (chosenStudent.father || chosenStudent.profile?.father || '').toUpperCase().trim();
            const mobile = (chosenStudent.mobile || chosenStudent.phone || chosenStudent.profile?.mobile || '').trim();
            const mother = (chosenStudent.mother || chosenStudent.profile?.mother || '').toUpperCase().trim();
            const motherMobile = (chosenStudent.motherMobile || chosenStudent.profile?.motherMobile || '').trim();
            const address = (chosenStudent.address || chosenStudent.profile?.address || '').trim();

            groupStudents.forEach(st => {
                const stRef = doc(db, `${BASE_PATH}/students`, st.id);
                const updatePayload = {
                    father: father,
                    mobile: mobile,
                    mother: mother,
                    motherMobile: motherMobile,
                    address: address,
                    'profile.father': father,
                    'profile.mobile': mobile,
                    'profile.mother': mother,
                    'profile.motherMobile': motherMobile,
                    'profile.address': address,
                    updatedAt: new Date().toISOString()
                };
                batch.update(stRef, updatePayload);

                // Update local memory objects
                st.father = father;
                st.mobile = mobile;
                st.mother = mother;
                st.motherMobile = motherMobile;
                st.address = address;
                if (!st.profile) st.profile = {};
                st.profile.father = father;
                st.profile.mobile = mobile;
                st.profile.mother = mother;
                st.profile.motherMobile = motherMobile;
                st.profile.address = address;
            });
        }

        if (isEdit && groupId) {
            // 2a. Update existing group document
            const groupRef = doc(db, `${BASE_PATH}/studentGroups`, groupId);
            const groupPayload = {
                memberIds: studentIds,
                fee: groupFee,
                updatedAt: nowTs
            };
            batch.update(groupRef, groupPayload);

            await batch.commit();

            // Deduplicated update of local memory
            const exIdx = studentGroups.findIndex(g => g.id === groupId);
            if (exIdx >= 0) {
                studentGroups[exIdx] = { ...studentGroups[exIdx], ...groupPayload };
            } else {
                studentGroups.push({ id: groupId, ...groupPayload });
            }

            await logAuditEvent({
                category: 'group',
                action: 'group.update',
                entityType: 'studentGroup',
                entityId: groupId,
                message: `Student group updated with ${studentIds.length} members. Fee: ₹${groupFee}.${chosenStudent ? ` Family details consolidated from ${chosenStudent.name}.` : ''}`
            });

            closeUnifyFamilyModal();
            renderStudentGroups();
            if (typeof renderStudentList === 'function') renderStudentList();

            alert(`Student Group updated successfully!${chosenStudent ? ' Family details (Father, Mother, Phone numbers, and Address) have been unified across all members.' : ''}`);
        } else {
            // 2b. Create new student group document
            const groupRef = doc(collection(db, `${BASE_PATH}/studentGroups`));
            const groupPayload = {
                academicYear: activeAcademicYear || currentAcademicYear,
                memberIds: studentIds,
                fee: groupFee,
                createdAt: nowTs,
                updatedAt: nowTs
            };
            batch.set(groupRef, groupPayload);

            await batch.commit();

            // Deduplicated update of local memory
            const exIdx = studentGroups.findIndex(g => g.id === groupRef.id);
            if (exIdx >= 0) {
                studentGroups[exIdx] = { ...studentGroups[exIdx], ...groupPayload };
            } else {
                studentGroups.push({ id: groupRef.id, ...groupPayload });
            }

            await logAuditEvent({
                category: 'group',
                action: 'group.create',
                entityType: 'studentGroup',
                entityId: groupRef.id,
                message: `Student group created with ${studentIds.length} members. Fee: ₹${groupFee}.${chosenStudent ? ` Family details consolidated from ${chosenStudent.name}.` : ''}`
            });

            closeUnifyFamilyModal();
            renderStudentGroups();
            if (typeof renderStudentList === 'function') renderStudentList();

            // Clear creation form
            document.getElementById('num-of-students-group').value = '';
            document.getElementById('group-monthly-fee').value = '';
            document.getElementById('group-creation-container').innerHTML = '';
            document.getElementById('create-group-btn-container')?.classList.add('hidden');

            alert(`Student Group created successfully!${chosenStudent ? ' Family details (Father, Mother, Phone numbers, and Address) have been unified across all members.' : ''}`);
        }
    } catch (err) {
        console.error("Failed to save student group:", err);
        alert("Failed to save student group. Please check your network connection and try again.");
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> <span>Confirm &amp; Save Group</span>';
        }
    }
};

document.getElementById('unify-family-modal-close')?.addEventListener('click', closeUnifyFamilyModal);
document.getElementById('unify-family-cancel-btn')?.addEventListener('click', closeUnifyFamilyModal);
document.getElementById('unify-family-confirm-btn')?.addEventListener('click', handleConfirmGroupCreation);

document.getElementById('create-group-btn').addEventListener('click', async () => {
    if(!requirePermission('groups.manage')) return;

    const selects = Array.from(document.querySelectorAll('.grp-stu')).map((input) => {
        const idx = input.dataset.idx;
        const className = document.querySelector(`.grp-cls[data-idx="${idx}"]`)?.value || '';
        const gender = document.querySelector(`.grp-gen[data-idx="${idx}"]`)?.value || '';
        return findStudentFromTypedGroupValue(input.value, className, gender)?.id || '';
    }).filter(Boolean);

    if (selects.length < 2 || new Set(selects).size !== selects.length) {
        return alert("Please select at least 2 unique valid students from the suggestions.");
    }

    const feeInput = document.getElementById('group-monthly-fee');
    const feeVal = feeInput?.value?.trim();
    const fee = parseFloat(feeVal);

    if (!feeVal || isNaN(fee) || fee <= 0) {
        alert("Group Monthly Fee is mandatory. Please enter a valid fee amount.");
        feeInput?.focus();
        return;
    }

    openUnifyFamilyModal({
        studentIds: selects,
        groupFee: fee
    });
});

// --- 6.1 RESULT MANAGEMENT ---
if (document.getElementById('results-page')) {
const RESULT_EXAMS = ['quarterly', 'halfYearly', 'annual'];
const RESULT_EXAM_LABELS = { quarterly: 'Quarterly', halfYearly: 'Half-Yearly', annual: 'Annual' };
const DEFAULT_GRADE_RULES = [
    { grade: 'A+', min: 90, max: 100 },
    { grade: 'A', min: 80, max: 89.99 },
    { grade: 'B+', min: 70, max: 79.99 },
    { grade: 'B', min: 60, max: 69.99 },
    { grade: 'C', min: 50, max: 59.99 },
    { grade: 'D', min: 35, max: 49.99 },
    { grade: 'F', min: 0, max: 34.99 }
];
let resultCenterSettings = {
    examLabel: '',
    publishAt: '',
    locked: false,
    blockedClasses: [],
    gradeRules: DEFAULT_GRADE_RULES,
    gradeBasis: 'raw',
    gradeScaleTotal: 100,
    classProgressionMap: {},
    posterTemplateUrl: '',
    enableStudentPhotoModule: false,
    allowStudentSelfPhotoUpload: false
};
let examResultsCache = [];

const getResultSchemaForClass = (classLabel, academicYear = getActiveAcademicYearLabel()) =>
    resultSchemas.find((entry) => entry.academicYear === academicYear && entry.classLabel === classLabel);

const calcStatusFromMarks = (marks = {}, schema = null) => {
    if (!schema?.subjects?.length) return 'FAIL';
    const hasFail = schema.subjects.some((subject) => {
        const value = marks[subject.code];
        const raw = String(value ?? '').trim().toUpperCase();
        if (raw === 'A') return true;
        if (raw === 'P') return false;
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? numeric < Number(subject.passMark || 0) : true;
    });
    return hasFail ? 'FAIL' : 'PASS';
};

const calcTotals = (marks = {}, schema = null) => {
    const subjects = schema?.subjects || [];
    let obtained = 0;
    let maximum = 0;
    subjects.forEach((subject) => {
        const raw = String(marks[subject.code] ?? '').trim().toUpperCase();
        maximum += Number(subject.totalMark || 100);
        if (raw === 'P') obtained += Number(subject.passMark || 18);
        else if (raw === 'A') obtained += 0;
        else obtained += Number(raw) || 0;
    });
    const percentage = maximum > 0 ? Number(((obtained / maximum) * 100).toFixed(2)) : 0;
    return { obtained, maximum, percentage, passStatus: calcStatusFromMarks(marks, schema) };
};

const calcGradeFromValue = ({ percentage = 0, raw = 0 } = {}) => {
    const basis = resultCenterSettings.gradeBasis || 'raw';
    const score = basis === 'percentage' ? Number(percentage) : Number(raw);
    const rules = (resultCenterSettings.gradeRules || DEFAULT_GRADE_RULES)
        .map((rule) => ({ ...rule, min: Number(rule.min), max: Number(rule.max) }))
        .filter((rule) => rule.grade && Number.isFinite(rule.min) && Number.isFinite(rule.max));
    const match = rules.find((rule) => score >= rule.min && score <= rule.max);
    return match?.grade || '-';
};

const parseResultSubjects = (raw = '') => raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
        const parts = line.includes(',') ? line.split(',') : line.split('|');
        const [name = '', totalMark = '100', passMark = '35'] = parts.map((part) => part.trim());
        return {
            name,
            code: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24),
            totalMark: Number(totalMark) || 100,
            passMark: Number(passMark) || 35
        };
    })
    .filter((subject) => subject.name);

const renderResultDashboardCards = () => {
    const filtered = examResultsCache.filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.published === true);
    const passCount = filtered.filter((item) => item.totals?.passStatus === 'PASS').length;
    const passPct = filtered.length ? Math.round((passCount / filtered.length) * 100) : 0;
    document.getElementById('result-stat-students').textContent = String(students.length);
    document.getElementById('result-stat-classes').textContent = String(classes.length);
    document.getElementById('result-stat-published').textContent = String(filtered.length);
    document.getElementById('result-stat-passpct').textContent = `${passPct}%`;
    const analytics = RESULT_EXAMS.map((exam) => {
        const rows = filtered.filter((item) => item.examType === exam);
        const examPass = rows.filter((item) => item.totals?.passStatus === 'PASS').length;
        const examPct = rows.length ? Math.round((examPass / rows.length) * 100) : 0;
        return `<div class="bg-white border rounded-lg p-3"><div class="text-xs uppercase text-gray-500 font-bold">${exam}</div><div class="text-lg font-extrabold text-indigo-700">${examPct}% Pass</div><div class="text-[11px] text-gray-500">${rows.length} published</div></div>`;
    });
    document.getElementById('result-analytics-list').innerHTML = analytics.join('');
};

const populateResultSelectors = () => {
    classes = getClassesForActiveYear();
    const classOptions = classes.length ? classes : [];
    ['result-class-select', 'marks-class-select', 'published-class-select', 'draft-class-select', 'result-template-class-select', 'result-readiness-class-select'].forEach((id) => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        const optionsHtml = ['<option value="">-- Select Class --</option>', ...classOptions.map((classLabel) => `<option value="${escapeHtml(classLabel)}">${escapeHtml(classLabel)}</option>`)];
        select.innerHTML = optionsHtml.join('');
        if (classOptions.includes(current)) select.value = current;
        else select.value = '';
    });
    const blockedList = document.getElementById('blocked-classes-list');
    blockedList.innerHTML = classOptions.filter(Boolean).map((classLabel) => `
        <label class="flex items-center gap-2 text-sm bg-gray-50 border rounded px-2 py-1">
            <input type="checkbox" class="blocked-class-checkbox" value="${classLabel}" ${resultCenterSettings.blockedClasses?.includes(classLabel) ? 'checked' : ''}>
            <span>${escapeHtml(classLabel)}</span>
        </label>
    `).join('') || '<div class="text-xs text-gray-500">No classes configured.</div>';
};

const renderPublishedSummary = (rows = null) => {
    const summaryEl = document.getElementById('published-summary-strip');
    if (!summaryEl) return;
    const dataset = Array.isArray(rows)
        ? rows
        : examResultsCache.filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.published === true);
    const passCount = dataset.filter((item) => item.totals?.passStatus === 'PASS').length;
    const failCount = dataset.filter((item) => item.totals?.passStatus === 'FAIL').length;
    const passPct = dataset.length ? Math.round((passCount / dataset.length) * 100) : 0;
    summaryEl.innerHTML = `
        <div class="published-summary-card">
            <div class="published-summary-label">Filtered Results</div>
            <div class="published-summary-value">${dataset.length}</div>
        </div>
        <div class="published-summary-card">
            <div class="published-summary-label">Pass / Fail</div>
            <div class="published-summary-value">${passCount} / ${failCount}</div>
        </div>
        <div class="published-summary-card">
            <div class="published-summary-label">Pass Percentage</div>
            <div class="published-summary-value">${passPct}%</div>
        </div>
    `;
};

const runResultReadinessChecklist = () => {
    const classLabel = document.getElementById('result-readiness-class-select')?.value || '';
    const examType = document.getElementById('result-readiness-exam-select')?.value || 'quarterly';
    const statusEl = document.getElementById('result-readiness-status');
    const gridEl = document.getElementById('result-readiness-grid');
    const notesEl = document.getElementById('result-readiness-notes');
    if (!statusEl || !gridEl || !notesEl) return;
    if (!classLabel) {
        statusEl.className = 'result-readiness-pill result-readiness-pending';
        statusEl.textContent = 'Pending';
        gridEl.innerHTML = '';
        notesEl.textContent = 'Select a class and exam to run checklist.';
        return;
    }

    const classStudents = students.filter((student) => student.class === classLabel);
    const rows = examResultsCache.filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.classLabel === classLabel && item.examType === examType);
    const publishedRows = rows.filter((row) => row.published === true);
    const draftRows = rows.filter((row) => row.published !== true);
    const studentIdsWithRows = new Set(rows.map((row) => row.studentId));
    const missingRows = classStudents.filter((student) => !studentIdsWithRows.has(student.id));
    const invalidRows = rows.filter((row) => {
        const marks = row.marks || {};
        const values = Object.values(marks);
        if (!values.length) return true;
        return values.some((value) => {
            const raw = String(value ?? '').trim().toUpperCase();
            if (!raw) return true;
            if (raw === 'A' || raw === 'P') return false;
            return !Number.isFinite(Number(raw));
        });
    });
    const readinessPass = missingRows.length === 0 && invalidRows.length === 0 && draftRows.length === 0 && publishedRows.length > 0;
    statusEl.className = `result-readiness-pill ${readinessPass ? 'result-readiness-pass' : 'result-readiness-fail'}`;
    statusEl.textContent = readinessPass ? 'Ready to Publish' : 'Needs Review';
    gridEl.innerHTML = `
        <div class="result-readiness-item"><div class="result-readiness-label">Class Strength</div><div class="result-readiness-value">${classStudents.length}</div></div>
        <div class="result-readiness-item"><div class="result-readiness-label">Published</div><div class="result-readiness-value">${publishedRows.length}</div></div>
        <div class="result-readiness-item"><div class="result-readiness-label">Draft</div><div class="result-readiness-value">${draftRows.length}</div></div>
        <div class="result-readiness-item"><div class="result-readiness-label">Missing Rows</div><div class="result-readiness-value">${missingRows.length}</div></div>
    `;
    if (readinessPass) {
        notesEl.textContent = `${RESULT_EXAM_LABELS[examType] || examType}: Checklist passed for ${classLabel}. You can proceed with publish/print confidently.`;
        return;
    }
    const notes = [];
    if (!publishedRows.length) notes.push('No published rows available.');
    if (draftRows.length) notes.push(`${draftRows.length} draft row(s) still pending publish.`);
    if (missingRows.length) notes.push(`${missingRows.length} student(s) do not have result rows.`);
    if (invalidRows.length) notes.push(`${invalidRows.length} row(s) contain invalid/blank mark values.`);
    notesEl.textContent = `${RESULT_EXAM_LABELS[examType] || examType}: ${notes.join(' ')}`;
};

const populateMarksStudentSelect = () => {
    const selectedClass = document.getElementById('marks-class-select').value;
    const studentSelect = document.getElementById('marks-student-select');
    const eligible = students.filter((student) => student.class === selectedClass);
    const options = ['<option value="">-- Select Student --</option>', ...eligible.map((student) => `<option value="${student.id}">${escapeHtml(student.name)} (${escapeHtml(student.adm || '-')})</option>`)];
    studentSelect.innerHTML = options.join('');
};

const renderGradeRulesEditor = () => {
    const rows = resultCenterSettings.gradeRules?.length ? resultCenterSettings.gradeRules : DEFAULT_GRADE_RULES;
    const container = document.getElementById('grade-rules-rows');
    container.innerHTML = rows.map((rule, index) => `
        <div class="grid grid-cols-3 gap-2">
            <input class="grade-rule-grade p-2 border rounded" data-index="${index}" placeholder="Grade" value="${escapeHtml(String(rule.grade || ''))}">
            <input type="number" step="0.01" class="grade-rule-min p-2 border rounded" data-index="${index}" placeholder="Min %" value="${escapeHtml(String(rule.min ?? ''))}">
            <input type="number" step="0.01" class="grade-rule-max p-2 border rounded" data-index="${index}" placeholder="Max %" value="${escapeHtml(String(rule.max ?? ''))}">
        </div>
    `).join('');
};

const buildGradeRulesByTotal = (totalMark = 100) => {
    const normalizedTotal = Number(totalMark) === 50 ? 50 : 100;
    if (normalizedTotal === 50) {
        return [
            { grade: 'A+', min: 45, max: 50 },
            { grade: 'A', min: 40, max: 44.99 },
            { grade: 'B+', min: 35, max: 39.99 },
            { grade: 'B', min: 30, max: 34.99 },
            { grade: 'C', min: 25, max: 29.99 },
            { grade: 'D', min: 18, max: 24.99 },
            { grade: 'F', min: 0, max: 17.99 }
        ];
    }
    return [
        { grade: 'A+', min: 90, max: 100 },
        { grade: 'A', min: 80, max: 89.99 },
        { grade: 'B+', min: 70, max: 79.99 },
        { grade: 'B', min: 60, max: 69.99 },
        { grade: 'C', min: 50, max: 59.99 },
        { grade: 'D', min: 35, max: 49.99 },
        { grade: 'F', min: 0, max: 34.99 }
    ];
};

const collectGradeRulesFromEditor = () => {
    const grades = Array.from(document.querySelectorAll('.grade-rule-grade'));
    return grades.map((gradeInput, index) => ({
        grade: gradeInput.value.trim(),
        min: Number(document.querySelector(`.grade-rule-min[data-index="${index}"]`)?.value ?? NaN),
        max: Number(document.querySelector(`.grade-rule-max[data-index="${index}"]`)?.value ?? NaN)
    })).filter((rule) => rule.grade && Number.isFinite(rule.min) && Number.isFinite(rule.max));
};

const renderClassProgressionMap = () => {
    const mapList = document.getElementById('class-progression-map-list');
    const map = resultCenterSettings.classProgressionMap || {};
    if (!classes.length) {
        mapList.innerHTML = '<div class="text-xs text-gray-500">No classes configured.</div>';
        return;
    }
    mapList.innerHTML = classes.map((classLabel) => {
        const selectedNext = map[classLabel] || '';
        const options = [
            '<option value="">-- Select Next --</option>',
            ...classes.filter((candidate) => candidate !== classLabel).map((candidate) => `<option value="${candidate}" ${selectedNext === candidate ? 'selected' : ''}>${candidate}</option>`),
            `<option value="ALUMNI" ${selectedNext === 'ALUMNI' || selectedNext === 'GRADUATED' ? 'selected' : ''}>ALUMNI</option>`
        ].join('');
        return `
            <label class="text-xs font-bold bg-gray-50 border rounded p-2">
                <div class="mb-1">${escapeHtml(classLabel)} →</div>
                <select class="progression-next-select w-full p-1.5 border rounded text-xs" data-class="${classLabel}">${options}</select>
            </label>
        `;
    }).join('');
};

const renderResultManagement = () => {
    const settingsTab = document.getElementById('result-settings-tab');
    const settingsBlocks = ['result-publish-settings-block', 'result-lock-settings-block', 'result-poster-settings-block', 'result-copy-prev-year-block']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    if (settingsTab && settingsBlocks.length && settingsTab.children.length === 0) {
        settingsBlocks.forEach((block) => settingsTab.appendChild(block));
    }
    enforceResultOperatorResultTabs();
    document.getElementById('result-year-badge').textContent = `Academic Year: ${getActiveAcademicYearLabel()}`;
    document.getElementById('result-publish-exam-name').value = resultCenterSettings.examLabel || '';
    document.getElementById('result-publish-at').value = resultCenterSettings.publishAt || '';
    document.getElementById('result-lock-toggle').checked = resultCenterSettings.locked === true;
    document.getElementById('result-poster-template-url').value = resultCenterSettings.posterTemplateUrl || '';
    document.getElementById('result-photo-module-toggle').checked = resultCenterSettings.enableStudentPhotoModule === true;
    document.getElementById('result-self-photo-upload-toggle').checked = resultCenterSettings.allowStudentSelfPhotoUpload === true;
    document.getElementById('grade-total-mark-select').value = String(resultCenterSettings.gradeScaleTotal || 100);
    const targetYearSelect = document.getElementById('promotion-target-year-select');
    const targetCurrent = targetYearSelect.value;
    targetYearSelect.innerHTML = academicYears.map((year) => `<option value="${year.label}">${year.label}</option>`).join('');
    targetYearSelect.value = academicYears.some((year) => year.label === targetCurrent) ? targetCurrent : (academicYears.find((year) => year.label !== getActiveAcademicYearLabel())?.label || getActiveAcademicYearLabel());
    populateResultSelectors();
    populateMarksStudentSelect();
    renderGradeRulesEditor();
    renderClassProgressionMap();
    renderResultDashboardCards();
    runResultReadinessChecklist();
    renderPublishedSummary();

    const classSelect = document.getElementById('result-class-select');
    const selectedClass = classSelect.value;
    const schema = resultSchemas.find((entry) => entry.academicYear === getActiveAcademicYearLabel() && entry.classLabel === selectedClass);
    document.getElementById('result-subjects-input').value = schema?.subjects?.map((subject) => `${subject.name},${subject.totalMark || 100},${subject.passMark || 35}`).join('\n') || '';
    document.getElementById('result-show-quarterly').checked = schema?.examConfigs?.quarterly?.showMarksToStudents === true;
    document.getElementById('result-show-halfyearly').checked = schema?.examConfigs?.halfYearly?.showMarksToStudents === true;
    document.getElementById('result-show-annual').checked = schema?.examConfigs?.annual?.showMarksToStudents === true;

    const listEl = document.getElementById('result-schema-list');
    const rows = resultSchemas
        .filter((entry) => entry.academicYear === getActiveAcademicYearLabel())
        .sort((a, b) => (a.classLabel || '').localeCompare(b.classLabel || ''))
        .map((entry) => `
            <div class="border rounded-xl p-4 bg-gray-50">
                <div class="flex items-center justify-between mb-2">
                    <div class="font-bold text-gray-900">${escapeHtml(entry.classLabel || '--')}</div>
                    <div class="text-[11px] uppercase tracking-wider text-gray-500">${escapeHtml(entry.academicYear || '--')}</div>
                </div>
                <div class="text-xs text-gray-600 mb-2">${(entry.subjects || []).map((subject) => `${escapeHtml(subject.name)} (${subject.passMark}/${subject.totalMark})`).join(', ') || 'No subjects set.'}</div>
                <div class="text-[11px] font-semibold text-indigo-600">Show Marks: Q-${entry.examConfigs?.quarterly?.showMarksToStudents ? 'ON' : 'OFF'} | H-${entry.examConfigs?.halfYearly?.showMarksToStudents ? 'ON' : 'OFF'} | A-${entry.examConfigs?.annual?.showMarksToStudents ? 'ON' : 'OFF'}</div>
            </div>
        `);
    listEl.innerHTML = rows.length ? rows.join('') : '<p class="text-sm text-gray-500 italic">No result schema saved for this academic year.</p>';
};

const switchResultTab = (tabId) => {
    currentResultTabId = tabId;
    document.querySelectorAll('.result-tab-content').forEach((panel) => panel.classList.toggle('hidden', panel.id !== tabId));
    document.querySelectorAll('.result-tab-btn').forEach((button) => {
        const active = button.dataset.tab === tabId;
        button.classList.toggle('bg-indigo-600', active);
        button.classList.toggle('text-white', active);
        button.classList.toggle('bg-white', !active);
        button.classList.toggle('border', !active);
    });
    updateResultDrawerActiveState();
};

document.querySelectorAll('.result-tab-btn').forEach((button) => {
    button.addEventListener('click', () => switchResultTab(button.dataset.tab));
});
document.getElementById('add-grade-rule-row-btn').addEventListener('click', () => {
    resultCenterSettings.gradeRules = [...(resultCenterSettings.gradeRules || DEFAULT_GRADE_RULES), { grade: '', min: 0, max: 0 }];
    renderGradeRulesEditor();
});
document.getElementById('grade-total-mark-select')?.addEventListener('change', () => {
    const totalMark = Number(document.getElementById('grade-total-mark-select').value || 100);
    resultCenterSettings.gradeScaleTotal = totalMark === 50 ? 50 : 100;
    resultCenterSettings.gradeBasis = 'raw';
    resultCenterSettings.gradeRules = buildGradeRulesByTotal(resultCenterSettings.gradeScaleTotal);
    renderGradeRulesEditor();
});
document.getElementById('save-grade-rules-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const rules = collectGradeRulesFromEditor();
    if (!rules.length) return alert('Enter at least one valid grade rule.');
    resultCenterSettings.gradeRules = rules;
    resultCenterSettings.gradeScaleTotal = Number(document.getElementById('grade-total-mark-select').value || 100) === 50 ? 50 : 100;
    resultCenterSettings.gradeBasis = 'raw';
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
        academicYear: getActiveAcademicYearLabel(),
        examLabel: resultCenterSettings.examLabel || '',
        publishAt: resultCenterSettings.publishAt || '',
        locked: resultCenterSettings.locked === true,
        blockedClasses: resultCenterSettings.blockedClasses || [],
        gradeBasis: resultCenterSettings.gradeBasis,
        gradeScaleTotal: resultCenterSettings.gradeScaleTotal,
        gradeRules: rules,
        classProgressionMap: resultCenterSettings.classProgressionMap || {},
        updatedAt: new Date().toISOString()
    }, { merge: true });
    alert('Grade rules saved.');
});
document.getElementById('save-class-progression-map-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const nextMap = {};
    document.querySelectorAll('.progression-next-select').forEach((select) => {
        const classLabel = select.dataset.class;
        const nextClass = select.value;
        if (classLabel && nextClass) nextMap[classLabel] = nextClass;
    });
    resultCenterSettings.classProgressionMap = nextMap;
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
        academicYear: getActiveAcademicYearLabel(),
        classProgressionMap: nextMap,
        examLabel: resultCenterSettings.examLabel || '',
        publishAt: resultCenterSettings.publishAt || '',
        locked: resultCenterSettings.locked === true,
        blockedClasses: resultCenterSettings.blockedClasses || [],
        gradeBasis: resultCenterSettings.gradeBasis || 'raw',
        gradeScaleTotal: resultCenterSettings.gradeScaleTotal || 100,
        gradeRules: resultCenterSettings.gradeRules || DEFAULT_GRADE_RULES,
        classProgressionMap: resultCenterSettings.classProgressionMap || {},
        updatedAt: new Date().toISOString()
    }, { merge: true });
    alert('Class progression map saved.');
});
document.getElementById('result-class-select').addEventListener('change', renderResultManagement);
document.getElementById('marks-class-select').addEventListener('change', populateMarksStudentSelect);
document.getElementById('save-result-schema-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const classLabel = document.getElementById('result-class-select').value;
    if (!classLabel) return alert('Please add classes first, then configure result schema.');
    const subjects = parseResultSubjects(document.getElementById('result-subjects-input').value);
    if (!subjects.length) return alert('Please provide at least one valid subject.');
    if(!confirm("Save result schema?")) return;
    const payload = {
        academicYear: getActiveAcademicYearLabel(),
        classLabel,
        subjects,
        examConfigs: {
            quarterly: { label: 'Quarterly', showMarksToStudents: document.getElementById('result-show-quarterly').checked },
            halfYearly: { label: 'Half-Yearly', showMarksToStudents: document.getElementById('result-show-halfyearly').checked },
            annual: { label: 'Annual', showMarksToStudents: document.getElementById('result-show-annual').checked }
        },
        updatedAt: new Date().toISOString()
    };
    const schemaId = `${payload.academicYear}__${classLabel}`;
    await setDoc(doc(db, `${BASE_PATH}/resultSchemas`, schemaId), payload, { merge: true });
    await logAuditEvent({ category: 'security', action: 'results.schema.save', entityType: 'resultSchema', entityId: schemaId, message: `Result schema saved for ${classLabel}.` });
    alert('Result schema saved successfully.');
});
document.getElementById('result-save-publish-settings-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    resultCenterSettings.examLabel = document.getElementById('result-publish-exam-name').value.trim();
    resultCenterSettings.publishAt = document.getElementById('result-publish-at').value || '';
    resultCenterSettings.locked = document.getElementById('result-lock-toggle').checked;
    const payload = {
        academicYear: getActiveAcademicYearLabel(),
        examLabel: resultCenterSettings.examLabel,
        publishAt: resultCenterSettings.publishAt,
        locked: resultCenterSettings.locked,
        blockedClasses: resultCenterSettings.blockedClasses || [],
        gradeBasis: resultCenterSettings.gradeBasis || 'raw',
        gradeScaleTotal: resultCenterSettings.gradeScaleTotal || 100,
        gradeRules: resultCenterSettings.gradeRules || DEFAULT_GRADE_RULES,
        updatedAt: new Date().toISOString()
    };
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), payload, { merge: true });
    await logAuditEvent({ category: 'security', action: 'results.settings.save', entityType: 'settings', entityId: 'resultCenter', message: 'Result publish settings updated.' });
    alert('Publish settings saved.');
});
document.getElementById('result-save-poster-settings-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    resultCenterSettings.posterTemplateUrl = document.getElementById('result-poster-template-url').value.trim();
    resultCenterSettings.enableStudentPhotoModule = document.getElementById('result-photo-module-toggle').checked;
    resultCenterSettings.allowStudentSelfPhotoUpload = document.getElementById('result-self-photo-upload-toggle').checked;
    if (!resultCenterSettings.enableStudentPhotoModule) {
        resultCenterSettings.allowStudentSelfPhotoUpload = false;
        document.getElementById('result-self-photo-upload-toggle').checked = false;
    }
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
        academicYear: getActiveAcademicYearLabel(),
        posterTemplateUrl: resultCenterSettings.posterTemplateUrl || '',
        enableStudentPhotoModule: resultCenterSettings.enableStudentPhotoModule === true,
        allowStudentSelfPhotoUpload: resultCenterSettings.allowStudentSelfPhotoUpload === true,
        updatedAt: new Date().toISOString()
    }, { merge: true });
    await logAuditEvent({ category: 'security', action: 'results.poster.settings.save', entityType: 'settings', entityId: 'resultCenter', message: 'Result poster/photo settings updated.' });
    alert('Poster and photo settings saved.');
});
document.getElementById('result-photo-module-toggle')?.addEventListener('change', (event) => {
    if (!event.target.checked) {
        document.getElementById('result-self-photo-upload-toggle').checked = false;
    }
});
document.getElementById('result-self-photo-upload-toggle')?.addEventListener('change', (event) => {
    if (event.target.checked) {
        document.getElementById('result-photo-module-toggle').checked = true;
    }
});
document.getElementById('result-download-template-guide-btn')?.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 42px Arial';
    ctx.fillText('Poster Template Guide (1080 x 1350)', 120, 90);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(70, 170, 260, 260); // photo placeholder
    ctx.fillStyle = '#64748b';
    ctx.font = '28px Arial';
    ctx.fillText('Student Photo', 90, 315);
    ctx.strokeRect(360, 200, 640, 90); // name
    ctx.fillText('Student Name', 390, 255);
    ctx.strokeRect(360, 320, 300, 70); // class
    ctx.fillText('Class - 6', 390, 365);
    ctx.strokeRect(680, 320, 320, 70); // rank
    ctx.fillText('Rank #1', 720, 365);
    const anchor = document.createElement('a');
    anchor.href = canvas.toDataURL('image/png');
    anchor.download = 'poster_template_guide_1080x1350.png';
    anchor.click();
});

document.getElementById('save-blocked-classes-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const blockedClasses = Array.from(document.querySelectorAll('.blocked-class-checkbox:checked')).map((checkbox) => checkbox.value);
    resultCenterSettings.blockedClasses = blockedClasses;
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
        academicYear: getActiveAcademicYearLabel(),
        blockedClasses,
        examLabel: resultCenterSettings.examLabel || '',
        publishAt: resultCenterSettings.publishAt || '',
        locked: resultCenterSettings.locked === true,
        gradeBasis: resultCenterSettings.gradeBasis || 'raw',
        gradeScaleTotal: resultCenterSettings.gradeScaleTotal || 100,
        gradeRules: resultCenterSettings.gradeRules || DEFAULT_GRADE_RULES,
        classProgressionMap: resultCenterSettings.classProgressionMap || {},
        updatedAt: new Date().toISOString()
    }, { merge: true });
    alert('Blocked classes updated.');
});

const downloadJsonFile = (name, data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
};

document.getElementById('export-snapshot-all-btn').addEventListener('click', () => {
    const year = getActiveAcademicYearLabel();
    const payload = {
        academicYear: year,
        exportedAt: new Date().toISOString(),
        settings: resultCenterSettings,
        schemas: resultSchemas.filter((schema) => schema.academicYear === year),
        results: examResultsCache.filter((row) => row.academicYear === year && row.published === true)
    };
    downloadJsonFile('snapshot.json', payload);
});

document.getElementById('export-snapshot-classwise-btn').addEventListener('click', () => {
    const year = getActiveAcademicYearLabel();
    const rows = examResultsCache.filter((row) => row.academicYear === year && row.published === true);
    const byClass = rows.reduce((acc, row) => {
        const key = row.classLabel || 'UNKNOWN';
        if (!acc[key]) acc[key] = [];
        acc[key].push(row);
        return acc;
    }, {});
    Object.entries(byClass).forEach(([classLabel, classRows]) => {
        downloadJsonFile(`snapshot_${classLabel.replace(/\s+/g, '_')}.json`, {
            academicYear: year,
            classLabel,
            exportedAt: new Date().toISOString(),
            settings: resultCenterSettings,
            schema: getResultSchemaForClass(classLabel, year),
            results: classRows
        });
    });
});

document.getElementById('result-copy-prev-year-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const currentYear = getActiveAcademicYearLabel();
    const [start, end] = currentYear.split('-').map((val) => Number(val));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return alert('Active academic year format should be YYYY-YYYY.');
    const previousYear = `${start - 1}-${end - 1}`;
    const previousSchemas = resultSchemas.filter((schema) => schema.academicYear === previousYear);
    if (!previousSchemas.length) return alert(`No schemas found in previous year (${previousYear}).`);
    if (!confirm(`Copy ${previousSchemas.length} class schema(s) from ${previousYear} to ${currentYear}?`)) return;
    await Promise.all(previousSchemas.map((schema) => {
        const docId = `${currentYear}__${schema.classLabel}`;
        return setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), {
            academicYear: currentYear,
            classLabel: schema.classLabel,
            subjects: schema.subjects || [],
            examConfigs: schema.examConfigs || {},
            copiedFromYear: previousYear,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    }));
    alert(`Copied schemas from ${previousYear} successfully.`);
});

document.getElementById('result-download-template-btn').addEventListener('click', () => {
    const normalizedClass = (document.getElementById('result-template-class-select').value || '').trim().toUpperCase();
    if (!normalizedClass) return alert('Select a class from template dropdown.');
    const schema = getResultSchemaForClass(normalizedClass);
    if (!schema?.subjects?.length) return alert('No subjects configured for this class.');
    const classStudents = students.filter((student) => student.class === normalizedClass);
    if (!classStudents.length) return alert('No students found in this class.');
    const subjectHeaders = schema.subjects.map((subject) => `${subject.name} [${subject.code}]`);
    const header = ['studentId', 'studentName', 'classLabel', 'examType', 'workingDays', 'presentDays', ...subjectHeaders].join(',');
    const lines = classStudents.map((student) => {
        const emptyMarks = subjectHeaders.map(() => '').join(',');
        return `${student.id},"${(student.name || '').replace(/"/g, '""')}",${normalizedClass},quarterly,,,${emptyMarks}`;
    });
    const csv = `${header}\n${lines.join('\n')}\n`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `result_bulk_template_${normalizedClass.replace(/\s+/g, '_')}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
});

const buildMarksSubjectInputs = (schema, existingData = {}) => {
    const container = document.getElementById('marks-subject-inputs');
    if (!schema?.subjects?.length) {
        container.innerHTML = '<div class="text-sm text-red-600">No subjects configured for this class.</div>';
        return;
    }
    container.innerHTML = schema.subjects.map((subject) => `
        <div class="border rounded p-2 bg-gray-50">
            <div class="text-xs font-bold text-gray-700 mb-1">${escapeHtml(subject.name)} (${subject.passMark}/${subject.totalMark})</div>
            <input class="marks-value-input w-full p-2 border rounded text-sm" data-code="${subject.code}" placeholder="Mark / A / P" value="${escapeHtml(String(existingData.marks?.[subject.code] ?? ''))}">
        </div>
    `).join('');
};

const loadMarksEntry = () => {
    const classLabel = document.getElementById('marks-class-select').value;
    const studentId = document.getElementById('marks-student-select').value;
    const examType = document.getElementById('marks-exam-select').value;
    if (!classLabel || !studentId) return alert('Select class and student.');
    const schema = getResultSchemaForClass(classLabel);
    const existing = examResultsCache.find((row) => row.academicYear === getActiveAcademicYearLabel() && row.classLabel === classLabel && row.studentId === studentId && row.examType === examType) || {};
    buildMarksSubjectInputs(schema, existing);
    document.getElementById('marks-working-days').value = existing.attendance?.workingDays ?? '';
    document.getElementById('marks-present-days').value = existing.attendance?.presentDays ?? '';
    document.getElementById('marks-entry-container').classList.remove('hidden');
};
document.getElementById('marks-load-btn').addEventListener('click', loadMarksEntry);

const saveMarksEntry = async (publish = false) => {
    if(!requirePermission('results.manage')) return;
    const classLabel = document.getElementById('marks-class-select').value;
    const studentId = document.getElementById('marks-student-select').value;
    const examType = document.getElementById('marks-exam-select').value;
    const schema = getResultSchemaForClass(classLabel);
    if (!schema?.subjects?.length) return alert('Configure subjects first.');

    const marks = {};
    document.querySelectorAll('.marks-value-input').forEach((input) => { marks[input.dataset.code] = input.value.trim(); });
    const grades = {};
    (schema.subjects || []).forEach((subject) => {
        const raw = String(marks[subject.code] ?? '').trim().toUpperCase();
        if (raw === 'A') grades[subject.code] = 'ABS';
        else if (raw === 'P') grades[subject.code] = 'P';
        else {
            const numeric = Number(raw);
            if (!Number.isFinite(numeric)) grades[subject.code] = '-';
            else {
                const percent = (numeric / Number(subject.totalMark || 100)) * 100;
                grades[subject.code] = calcGradeFromValue({ percentage: percent, raw: numeric });
            }
        }
    });
    const totals = calcTotals(marks, schema);
    const payload = {
        academicYear: getActiveAcademicYearLabel(),
        classLabel,
        studentId,
        examType,
        marks,
        grades,
        attendance: {
            workingDays: Number(document.getElementById('marks-working-days').value) || 0,
            presentDays: Number(document.getElementById('marks-present-days').value) || 0
        },
        totals,
        published: publish === true,
        showMarksToStudents: schema.examConfigs?.[examType]?.showMarksToStudents === true,
        updatedAt: new Date().toISOString()
    };
    const docId = `${payload.academicYear}__${classLabel}__${studentId}__${examType}`;
    await setDoc(doc(db, `${BASE_PATH}/examResults`, docId), payload, { merge: true });
    alert(publish ? 'Result published.' : 'Draft saved.');
};
document.getElementById('marks-save-draft-btn').addEventListener('click', () => saveMarksEntry(false));
document.getElementById('marks-publish-btn').addEventListener('click', () => saveMarksEntry(true));

document.getElementById('result-bulk-upload-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const file = document.getElementById('result-bulk-file').files?.[0];
    if (!file) return alert('Choose a file first.');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    if (!rows.length) return alert('No rows found.');
    let count = 0;
    for (const row of rows) {
        const studentId = String(row.studentId || '').trim();
        const classLabel = String(row.classLabel || '').trim().toUpperCase();
        const examType = String(row.examType || '').trim() || 'quarterly';
        if (!studentId || !classLabel) continue;
        const schema = getResultSchemaForClass(classLabel);
        if (!schema) continue;
        const docId = `${getActiveAcademicYearLabel()}__${classLabel}__${studentId}__${examType}`;
        const marks = {};
        const grades = {};
        const rowKeys = Object.keys(row);
        (schema.subjects || []).forEach((subject) => {
            const markKey = rowKeys.find((key) => {
                const normalizedKey = key.toString().trim().toUpperCase();
                return normalizedKey.includes(`[${subject.code}]`)
                    || normalizedKey === subject.code
                    || normalizedKey === subject.name.toUpperCase();
            });
            const raw = String(markKey ? row[markKey] : '').trim();
            marks[subject.code] = raw;
            const upper = raw.toUpperCase();
            if (upper === 'A') grades[subject.code] = 'ABS';
            else if (upper === 'P') grades[subject.code] = 'P';
            else {
                const numeric = Number(raw);
                grades[subject.code] = Number.isFinite(numeric)
                    ? calcGradeFromValue({ percentage: (numeric / Number(subject.totalMark || 100)) * 100, raw: numeric })
                    : '-';
            }
        });
        const payload = {
            academicYear: getActiveAcademicYearLabel(),
            classLabel,
            studentId,
            examType,
            marks,
            grades,
            attendance: { workingDays: Number(row.workingDays) || 0, presentDays: Number(row.presentDays) || 0 },
            totals: calcTotals(marks, schema),
            published: true,
            showMarksToStudents: schema.examConfigs?.[examType]?.showMarksToStudents === true,
            updatedAt: new Date().toISOString()
        };
        await setDoc(doc(db, `${BASE_PATH}/examResults`, docId), payload, { merge: true });
        count += 1;
    }
    alert(`${count} row(s) processed and published.`);
});

const renderPublishedResults = () => {
    const classLabel = document.getElementById('published-class-select').value;
    const examType = document.getElementById('published-exam-select').value;
    const rows = examResultsCache
        .filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.classLabel === classLabel && item.examType === examType && item.published === true)
        .sort((a, b) => (b.totals?.obtained || 0) - (a.totals?.obtained || 0))
        .map((item, index) => ({ ...item, rank: index + 1 }));
    const tableEl = document.getElementById('published-results-table');
    if (!rows.length) {
        tableEl.innerHTML = '<div class="text-sm text-gray-500">No published results for this filter.</div>';
        renderPublishedSummary([]);
        return;
    }
    tableEl.innerHTML = `
        <table class="w-full text-sm border-collapse">
            <thead><tr class="bg-gray-50 border-b"><th class="p-2 text-left"><input type="checkbox" id="published-select-all"></th><th class="p-2 text-left">Rank</th><th class="p-2 text-left">Student</th><th class="p-2 text-left">Total</th><th class="p-2 text-left">Status</th><th class="p-2 text-left">Action</th></tr></thead>
            <tbody>${rows.map((row) => {
                const student = students.find((item) => item.id === row.studentId);
                return `<tr class="border-b">
                    <td class="p-2"><input type="checkbox" class="published-row-check" value="${row.id}"></td>
                    <td class="p-2 font-bold">${row.rank}</td>
                    <td class="p-2">${escapeHtml(student?.name || row.studentId)}</td>
                    <td class="p-2">${escapeHtml(String(row.totals?.obtained || 0))}/${escapeHtml(String(row.totals?.maximum || 0))}</td>
                    <td class="p-2 font-bold ${row.totals?.passStatus === 'PASS' ? 'text-emerald-700' : 'text-red-700'}">${escapeHtml(row.totals?.passStatus || '--')}</td>
                    <td class="p-2"><button class="published-edit-btn text-indigo-700 font-bold mr-2" data-id="${row.id}" data-student="${row.studentId}" data-class="${row.classLabel}" data-exam="${row.examType}">Edit</button><button class="published-del-btn text-red-700 font-bold" data-id="${row.id}">Delete</button></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    document.getElementById('published-select-all')?.addEventListener('change', (event) => {
        document.querySelectorAll('.published-row-check').forEach((checkbox) => { checkbox.checked = event.target.checked; });
    });
    renderPublishedSummary(rows);
};
const renderDraftResults = () => {
    const classLabel = document.getElementById('draft-class-select').value;
    const examType = document.getElementById('draft-exam-select').value;
    const rows = examResultsCache
        .filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.classLabel === classLabel && item.examType === examType && item.published !== true)
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const tableEl = document.getElementById('draft-results-table');
    if (!rows.length) {
        tableEl.innerHTML = '<div class="text-sm text-gray-500">No draft results for this filter.</div>';
        return;
    }
    tableEl.innerHTML = `
        <table class="w-full text-sm border-collapse">
            <thead><tr class="bg-gray-50 border-b"><th class="p-2 text-left"><input type="checkbox" id="draft-select-all"></th><th class="p-2 text-left">Student</th><th class="p-2 text-left">Total</th><th class="p-2 text-left">Updated</th><th class="p-2 text-left">Action</th></tr></thead>
            <tbody>${rows.map((row) => {
                const student = students.find((item) => item.id === row.studentId);
                return `<tr class="border-b">
                    <td class="p-2"><input type="checkbox" class="draft-row-check" value="${row.id}"></td>
                    <td class="p-2">${escapeHtml(student?.name || row.studentId)}</td>
                    <td class="p-2">${escapeHtml(String(row.totals?.obtained || 0))}/${escapeHtml(String(row.totals?.maximum || 0))}</td>
                    <td class="p-2">${escapeHtml(formatDateTime(row.updatedAt || ''))}</td>
                    <td class="p-2"><button class="draft-edit-btn text-indigo-700 font-bold mr-2" data-id="${row.id}" data-student="${row.studentId}" data-class="${row.classLabel}" data-exam="${row.examType}">Edit</button><button class="draft-publish-btn text-emerald-700 font-bold mr-2" data-id="${row.id}">Publish</button><button class="draft-del-btn text-red-700 font-bold" data-id="${row.id}">Delete</button></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    document.getElementById('draft-select-all')?.addEventListener('change', (event) => {
        document.querySelectorAll('.draft-row-check').forEach((checkbox) => { checkbox.checked = event.target.checked; });
    });
};
document.getElementById('published-load-btn').addEventListener('click', renderPublishedResults);
document.getElementById('draft-load-btn').addEventListener('click', renderDraftResults);
document.getElementById('result-run-readiness-btn')?.addEventListener('click', runResultReadinessChecklist);
document.getElementById('result-readiness-class-select')?.addEventListener('change', runResultReadinessChecklist);
document.getElementById('result-readiness-exam-select')?.addEventListener('change', runResultReadinessChecklist);
document.getElementById('published-results-table').addEventListener('click', async (event) => {
    const editBtn = event.target.closest('.published-edit-btn');
    if (editBtn) {
        switchResultTab('result-marks-tab');
        document.getElementById('marks-class-select').value = editBtn.dataset.class;
        populateMarksStudentSelect();
        document.getElementById('marks-student-select').value = editBtn.dataset.student;
        document.getElementById('marks-exam-select').value = editBtn.dataset.exam;
        loadMarksEntry();
        return;
    }
    const delBtn = event.target.closest('.published-del-btn');
    if (delBtn && confirm('Delete this published result?')) {
        await deleteDoc(doc(db, `${BASE_PATH}/examResults`, delBtn.dataset.id));
    }
});
document.getElementById('published-bulk-delete-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const selectedIds = Array.from(document.querySelectorAll('.published-row-check:checked')).map((checkbox) => checkbox.value);
    if (!selectedIds.length) return alert('Select at least one result.');
    if (!confirm(`Delete ${selectedIds.length} selected results?`)) return;
    await Promise.all(selectedIds.map((id) => deleteDoc(doc(db, `${BASE_PATH}/examResults`, id))));
});
document.getElementById('draft-results-table').addEventListener('click', async (event) => {
    const editBtn = event.target.closest('.draft-edit-btn');
    if (editBtn) {
        switchResultTab('result-marks-tab');
        document.getElementById('marks-class-select').value = editBtn.dataset.class;
        populateMarksStudentSelect();
        document.getElementById('marks-student-select').value = editBtn.dataset.student;
        document.getElementById('marks-exam-select').value = editBtn.dataset.exam;
        loadMarksEntry();
        return;
    }
    const publishBtn = event.target.closest('.draft-publish-btn');
    if (publishBtn) {
        await updateDoc(doc(db, `${BASE_PATH}/examResults`, publishBtn.dataset.id), { published: true, updatedAt: new Date().toISOString() });
        return;
    }
    const delBtn = event.target.closest('.draft-del-btn');
    if (delBtn && confirm('Delete this draft result?')) {
        await deleteDoc(doc(db, `${BASE_PATH}/examResults`, delBtn.dataset.id));
    }
});
document.getElementById('draft-bulk-publish-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const selectedIds = Array.from(document.querySelectorAll('.draft-row-check:checked')).map((checkbox) => checkbox.value);
    if (!selectedIds.length) return alert('Select at least one draft result.');
    await Promise.all(selectedIds.map((id) => updateDoc(doc(db, `${BASE_PATH}/examResults`, id), { published: true, updatedAt: new Date().toISOString() })));
    alert(`${selectedIds.length} draft result(s) published.`);
});
document.getElementById('draft-bulk-delete-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const selectedIds = Array.from(document.querySelectorAll('.draft-row-check:checked')).map((checkbox) => checkbox.value);
    if (!selectedIds.length) return alert('Select at least one draft result.');
    if (!confirm(`Delete ${selectedIds.length} selected draft results?`)) return;
    await Promise.all(selectedIds.map((id) => deleteDoc(doc(db, `${BASE_PATH}/examResults`, id))));
});

const buildPublishedResultPrintableHtml = () => {
    const classLabel = document.getElementById('published-class-select').value;
    const examType = document.getElementById('published-exam-select').value;
    const schema = getResultSchemaForClass(classLabel);
    const subjects = schema?.subjects || [];
    const rows = examResultsCache
        .filter((item) => item.academicYear === getActiveAcademicYearLabel() && item.classLabel === classLabel && item.examType === examType && item.published === true)
        .sort((a, b) => (b.totals?.obtained || 0) - (a.totals?.obtained || 0))
        .map((item, index) => ({ ...item, rank: index + 1, student: students.find((student) => student.id === item.studentId) }));
    if (!rows.length) return '';

    const thSubjects = subjects.map((subject) => `<th>${escapeHtml(subject.name)} (${escapeHtml(String(subject.totalMark || 100))})</th>`).join('');
    const bodyRows = rows.map((row) => {
        const subjectMarks = subjects.map((subject) => `<td>${escapeHtml(String(row.marks?.[subject.code] ?? '-'))}</td>`).join('');
        return `<tr>
            <td>${escapeHtml(row.student?.name || row.studentId)}</td>
            ${subjectMarks}
            <td>${escapeHtml(String(row.totals?.obtained ?? 0))}/${escapeHtml(String(row.totals?.maximum ?? 0))}</td>
            <td>${escapeHtml(String(row.rank))}</td>
            <td>${escapeHtml(String(row.attendance?.presentDays ?? 0))}/${escapeHtml(String(row.attendance?.workingDays ?? 0))}</td>
            <td>${escapeHtml(row.totals?.passStatus || '--')}</td>
        </tr>`;
    }).join('');

    return `
        <div class="page">
            <h2>${escapeHtml(document.getElementById('app-name-header')?.textContent || 'Institution')}</h2>
            <div>Academic Year: ${escapeHtml(getActiveAcademicYearLabel())}</div>
            <div>Exam: ${escapeHtml(examType)} | Class: ${escapeHtml(classLabel)}</div>
            <table>
                <thead>
                    <tr>
                        <th>Student Name</th>
                        ${thSubjects}
                        <th>Total</th>
                        <th>Rank</th>
                        <th>Attendance</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
    `;
};
document.getElementById('published-download-pdf-btn').addEventListener('click', () => {
    const content = buildPublishedResultPrintableHtml();
    if (!content) return alert('No published rows available for PDF.');
    const popup = window.open('', '_blank');
    if (!popup) return alert('Popup blocked. Please allow popups and retry.');
    popup.document.write(`
        <html>
        <head>
            <title>Published Results</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; }
                .page { page-break-after: always; }
                table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
                th, td { border: 1px solid #333; padding: 6px; text-align: left; }
                th { background: #f2f2f2; }
            </style>
        </head>
        <body>${content}</body>
        </html>
    `);
    popup.document.close();
    popup.focus();
    popup.print();
});

document.getElementById('run-auto-promotion-btn').addEventListener('click', async () => {
    if(!requirePermission('results.manage')) return;
    const targetYear = sanitizeAcademicYearLabel(document.getElementById('promotion-target-year-select').value || '');
    if (targetYear === getActiveAcademicYearLabel()) return alert('Select a different target academic year for promotion.');
    const progressionMap = resultCenterSettings.classProgressionMap || {};
    const annualRows = examResultsCache.filter((row) => row.academicYear === getActiveAcademicYearLabel() && row.examType === 'annual' && row.published === true);
    if (!annualRows.length) return alert('No annual published results found.');
    const operations = [];
    annualRows.forEach((row) => {
        if (row.totals?.passStatus !== 'PASS') return;
        const student = students.find((item) => item.id === row.studentId);
        if (!student) return;
        const toClass = progressionMap[student.class] || '';
        if (!toClass) return;
        const isAlumni = toClass === 'ALUMNI' || toClass === 'GRADUATED';
        operations.push(updateDoc(doc(db, `${BASE_PATH}/students`, student.id), {
            class: isAlumni ? student.class : toClass,
            academicYear: targetYear,
            status: isAlumni ? 'Alumni' : (student.status || 'Active')
        }));
        operations.push(setDoc(
            getEnrollmentRef(targetYear, student.id),
            buildEnrollmentPayload(student.id, {
                ...student,
                class: isAlumni ? student.class : toClass,
                academicYear: targetYear,
                status: isAlumni ? 'Alumni' : (student.status || 'Active')
            }),
            { merge: true }
        ));
        const promotionId = `${getActiveAcademicYearLabel()}__${student.id}`;
        operations.push(setDoc(doc(db, `${BASE_PATH}/promotionDecisions`, promotionId), {
            academicYear: getActiveAcademicYearLabel(),
            studentId: student.id,
            fromClass: student.class,
            toClass: isAlumni ? 'ALUMNI' : toClass,
            targetAcademicYear: targetYear,
            basedOnExam: 'annual',
            decision: isAlumni ? 'ALUMNI' : 'PROMOTED',
            finalizedAt: new Date().toISOString()
        }, { merge: true }));
    });
    if (!operations.length) return alert('No promotable students found.');
    await Promise.all(operations);
    alert('Auto promotion completed for annual PASS students.');
});

}
// --- 6. FEE CONCESSIONS ---
const renderActiveConcessionsList = () => {
    const actCont = document.getElementById('active-concessions-list');
    const badgeCount = document.getElementById('active-conc-count-badge');
    const statusText = document.getElementById('active-conc-filter-status');
    if (!actCont) return;

    const sTerm = (document.getElementById('active-conc-search')?.value || '').trim().toLowerCase();
    const fCls = document.getElementById('active-conc-class-filter')?.value || 'all';

    const withConc = students.filter(s => s.concessionFee !== undefined && s.concessionFee !== null && s.concessionFee !== '');

    if (badgeCount) {
        badgeCount.textContent = String(withConc.length);
    }

    const filtered = withConc.filter(s => {
        let match = true;
        if (fCls && fCls !== 'all') {
            match = match && s.class === fCls;
        }
        if (sTerm) {
            const nameMatch = (s.name || '').toLowerCase().includes(sTerm);
            const admMatch = (s.adm || '').toLowerCase().includes(sTerm);
            const phoneMatch = (s.phone || '').toLowerCase().includes(sTerm) || (s.parentPhone || '').toLowerCase().includes(sTerm);
            const fatherMatch = (s.fatherName || '').toLowerCase().includes(sTerm);
            match = match && (nameMatch || admMatch || phoneMatch || fatherMatch);
        }
        return match;
    });

    if (statusText) {
        if (fCls !== 'all' || sTerm) {
            statusText.textContent = `Showing ${filtered.length} of ${withConc.length}`;
        } else {
            statusText.textContent = `Showing All (${withConc.length})`;
        }
    }

    if (filtered.length === 0) {
        actCont.innerHTML = `
            <div class="col-span-full text-center py-8 px-4 bg-white/80 rounded-xl border border-dashed border-emerald-200 text-slate-400 text-xs">
                <i class="fas fa-search text-emerald-300 text-lg mb-1.5 block"></i>
                ${withConc.length === 0 ? 'No active fee concessions registered yet.' : 'No concessions match the current search or class filter.'}
            </div>
        `;
        return;
    }

    actCont.innerHTML = filtered.map(s => {
        const studentName = escapeHtml(s.name || '-');
        const studentClass = escapeHtml(s.class || '--');
        const admNo = escapeHtml(s.adm || '-');
        const concessionAmt = escapeHtml(String(s.concessionFee));
        const father = s.fatherName ? escapeHtml(s.fatherName) : '';

        return `
            <div class="bg-white p-3.5 rounded-xl shadow-2xs border border-emerald-200 hover:border-emerald-300 hover:shadow-xs transition-all flex flex-col justify-between gap-3 group">
                <div class="space-y-2">
                    <!-- Top: Student Name and Class/Adm Badges -->
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0 flex-1">
                            <h4 class="font-bold text-sm text-slate-800 leading-snug break-words group-hover:text-emerald-950 transition-colors" title="${studentName}">
                                ${studentName}
                            </h4>
                            <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
                                <span class="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-[11px] font-bold border border-blue-200/80">
                                    Class ${studentClass}
                                </span>
                                <span class="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200/70">
                                    Adm: ${admNo}
                                </span>
                                ${father ? `<span class="text-[11px] text-slate-500 truncate max-w-[140px]" title="Guardian: ${father}"><i class="fas fa-user-shield text-[9px] text-slate-400 mr-0.5"></i>${father}</span>` : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Middle: Concession Monthly Fee Box -->
                    <div class="bg-emerald-50/60 border border-emerald-200/80 rounded-lg p-2 flex items-center justify-between">
                        <div class="flex items-center gap-1.5 text-xs text-emerald-900 font-semibold">
                            <i class="fas fa-hand-holding-usd text-emerald-600"></i>
                            <span>Special Monthly Fee</span>
                        </div>
                        <span class="inline-flex items-center font-black text-sm text-emerald-800 bg-white px-2 py-0.5 rounded-md border border-emerald-200 shadow-2xs">
                            ₹${concessionAmt}
                        </span>
                    </div>
                </div>

                <!-- Bottom: Action Buttons -->
                <div class="pt-2 border-t border-slate-100 flex items-center justify-end gap-1.5">
                    <button type="button" class="bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold px-2.5 py-1 rounded-md text-xs transition inline-flex items-center gap-1 concession-open-btn" data-id="${s.id}">
                        <i class="fas fa-edit text-[10px]"></i> Edit
                    </button>
                    <button type="button" class="bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold px-2.5 py-1 rounded-md text-xs transition inline-flex items-center gap-1 concession-delete-btn" data-id="${s.id}">
                        <i class="fas fa-trash-alt text-[10px]"></i> Remove
                    </button>
                </div>
            </div>
        `;
    }).join('');
};

const renderConcessionsList = () => {
    const fCls = document.getElementById('filter-conc-class')?.value || '';
    const sTerm = (document.getElementById('search-conc-input')?.value || '').trim().toLowerCase();
    const cont = document.getElementById('conc-list-container');
    const emptyState = document.getElementById('conc-list-empty');

    renderActiveConcessionsList();

    if (!cont || !emptyState) return;

    if (!fCls && !sTerm) {
        emptyState.classList.remove('hidden');
        cont.classList.add('hidden');
        return;
    }
    emptyState.classList.add('hidden');
    cont.classList.remove('hidden');

    const fil = students.filter(s => {
        let match = true;
        if (fCls) match = match && s.class === fCls;
        if (sTerm) match = match && ((s.name || '').toLowerCase().includes(sTerm) || (s.adm && String(s.adm).toLowerCase().includes(sTerm)));
        return match;
    });

    if (fil.length === 0) {
        cont.innerHTML = '<p class="text-xs text-slate-500 py-4 text-center">No matching students found.</p>';
        return;
    }

    cont.innerHTML = fil.map(s => {
        const hasConc = s.concessionFee !== undefined && s.concessionFee !== null && s.concessionFee !== '';
        return `
            <div class="p-2.5 bg-white border border-slate-200 rounded-lg shadow-2xs hover:border-blue-200 transition flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                    <div class="font-bold text-xs text-slate-800 break-words leading-tight">${escapeHtml(s.name || '-')}</div>
                    <div class="flex items-center gap-1.5 text-[11px] text-slate-500 mt-1">
                        <span class="font-medium text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">Class ${escapeHtml(s.class || '--')}</span>
                        <span>•</span>
                        <span>Adm: ${escapeHtml(s.adm || '-')}</span>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    ${hasConc ? `<span class="bg-emerald-50 text-emerald-800 text-[11px] font-bold px-2 py-0.5 rounded border border-emerald-200">₹${escapeHtml(String(s.concessionFee))}</span>` : ''}
                    <button type="button" class="bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold px-2.5 py-1 rounded-md text-xs transition concession-open-btn" data-id="${s.id}">
                        ${hasConc ? 'Edit' : 'Assign'}
                    </button>
                    ${hasConc ? `<button type="button" class="bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold px-2 py-1 rounded-md text-xs transition concession-delete-btn" data-id="${s.id}"><i class="fas fa-trash-alt text-[10px]"></i></button>` : ''}
                </div>
            </div>
        `;
    }).join('');
};

document.getElementById('filter-conc-class')?.addEventListener('change', renderConcessionsList);
document.getElementById('search-conc-input')?.addEventListener('input', renderConcessionsList);
document.getElementById('active-conc-search')?.addEventListener('input', renderActiveConcessionsList);
document.getElementById('active-conc-class-filter')?.addEventListener('change', renderActiveConcessionsList);

document.getElementById('fee-concessions-page')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.concession-open-btn');
    const delBtn = e.target.closest('.concession-delete-btn');
    if (btn) window.openConcModal(btn.dataset.id);
    if (delBtn) window.deleteConcession(delBtn.dataset.id);
});

window.openConcModal = (id) => {
    const s = students.find(st=>st.id===id); if(!s) return;
    document.getElementById('conc-student-id').value = s.id;
    document.getElementById('conc-student-name').textContent = `${s.name} (Class: ${s.class || '--'}, Adm: ${s.adm || '--'})`;
    document.getElementById('conc-fee-amount').value = (s.concessionFee !== undefined && s.concessionFee !== null) ? s.concessionFee : '';
    const hasConc = s.concessionFee !== undefined && s.concessionFee !== null && s.concessionFee !== '';
    document.getElementById('conc-remove').classList.toggle('hidden', !hasConc);
    document.getElementById('concession-popup').classList.remove('hidden'); 
    document.getElementById('concession-popup').classList.add('flex');
};

document.getElementById('conc-cancel').onclick = () => document.getElementById('concession-popup').classList.add('hidden');
document.getElementById('conc-save').onclick = async () => {
    if(!requirePermission('concessions.manage')) return;
    const amt = parseFloat(document.getElementById('conc-fee-amount').value);
    if(isNaN(amt) || amt < 0) return alert("Enter valid amount");
    if(!confirm("Save this fee concession to database?")) return;
    const studentId = document.getElementById('conc-student-id').value;
    const s = students.find(st => st.id === studentId);
    if (s) {
        s.concessionFee = amt;
        s.concessionAppliedAt = Date.now();
        s.concessionUpdatedAt = Date.now();
    }
    renderConcessionsList();
    document.getElementById('concession-popup').classList.add('hidden');
    await updateDoc(doc(db, `${BASE_PATH}/students`, studentId), { concessionFee: amt, concessionAppliedAt: Date.now(), concessionUpdatedAt: Date.now() });
    await logAuditEvent({ category: 'fee', action: 'concession.save', entityType: 'student', entityId: studentId, message: `Concession saved: ₹${amt}.` });
};

document.getElementById('conc-remove').onclick = async () => {
    const studentId = document.getElementById('conc-student-id').value;
    await window.deleteConcession(studentId);
    document.getElementById('concession-popup').classList.add('hidden');
};

window.deleteConcession = async (studentId) => {
    if(!requirePermission('concessions.manage')) return;
    if(!confirm("Remove fee concession for this student?")) return;
    const s = students.find(st => st.id === studentId);
    if (s) {
        s.concessionFee = null;
        s.concessionUpdatedAt = Date.now();
    }
    renderConcessionsList();
    await updateDoc(doc(db, `${BASE_PATH}/students`, studentId), { concessionFee: null, concessionUpdatedAt: Date.now() });
    await logAuditEvent({ category: 'fee', action: 'concession.remove', entityType: 'student', entityId: studentId, message: 'Concession removed.' });
};

// --- 7. FEE SETTINGS (Auto 12 Months Generation added in init) ---
document.getElementById('adv-fee-scope').addEventListener('change', (e) => {
    const val = e.target.value;
    document.getElementById('scope-global-container').classList.toggle('hidden', val !== 'global');
    document.getElementById('scope-class-wise-container').classList.toggle('hidden', val !== 'class-wise');
    document.getElementById('scope-specific-container').classList.toggle('hidden', val !== 'specific');
    if(val === 'class-wise') document.getElementById('class-wise-inputs').innerHTML = classes.map(c => `<div><label class="block text-xs font-bold text-gray-600 mb-1">${c}</label><input type="number" data-class="${c}" class="cw-input w-full p-2 border rounded text-sm font-medium" placeholder="₹"></div>`).join('');
    if(val === 'specific') document.getElementById('adv-fee-specific-class').innerHTML = classes.map(c => `<option value="${c}">${c}</option>`).join('');
});

document.getElementById('add-adv-fee-btn').addEventListener('click', () => {
    if(!requirePermission('fees.manage')) return;
    const name = document.getElementById('adv-fee-name')?.value.trim();
    const scope = document.getElementById('adv-fee-scope')?.value;
    const isMandatory = document.getElementById('adv-fee-receipt-req')?.checked || false;
    if (!name) return alert("Fee Item Name is mandatory.");
    let feeData = {
        key: `custom-${Date.now()}`,
        name: name,
        type: 'custom',
        isVisible: true,
        scope: scope,
        isReceiptMandatory: isMandatory,
        academicYear: getActiveAcademicYearLabel(),
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
    };

    if(scope === 'global') {
        const amt = parseFloat(document.getElementById('adv-fee-global-amt').value); if(isNaN(amt)) return alert("Enter valid global amount"); feeData.amount = amt;
    } else if(scope === 'class-wise') {
        let classAmounts = {}; document.querySelectorAll('.cw-input').forEach(inp => { const amt = parseFloat(inp.value); if(!isNaN(amt)) classAmounts[inp.dataset.class] = amt; });
        if(Object.keys(classAmounts).length === 0) return alert("Enter amount for at least one class"); feeData.classValues = classAmounts;
    } else if(scope === 'specific') {
        const targetCls = document.getElementById('adv-fee-specific-class').value, amt = parseFloat(document.getElementById('adv-fee-specific-amt').value);
        if(!targetCls || isNaN(amt)) return alert("Select class and enter valid amount"); feeData.targetClass = targetCls; feeData.amount = amt;
    }
    if(!confirm("Add new fee item?")) return;
    setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {feeItems: [...feeItems, feeData]}, {merge:true});
    logAuditEvent({ category: 'fee', action: 'fee.create', entityType: 'feeItem', entityId: feeData.key, message: `Fee item created: ${name}.` });
    document.getElementById('adv-fee-name').value = ''; document.getElementById('adv-fee-global-amt').value = ''; alert("Advanced Fee Created!");
});

const formatOrdinalDay = (day) => {
    const n = Math.min(31, Math.max(1, parseInt(day, 10) || 1));
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    switch (n % 10) {
        case 1: return `${n}st`;
        case 2: return `${n}nd`;
        case 3: return `${n}rd`;
        default: return `${n}th`;
    }
};

const populateFeeCollectionScheduleSelectors = () => {
    const startSel = document.getElementById('fee-collect-start-day');
    const endSel = document.getElementById('fee-collect-end-day');
    if (!startSel || !endSel) return;
    const dayOptions = Array.from({ length: 31 }, (_, idx) => {
        const d = idx + 1;
        return `<option value="${d}">${formatOrdinalDay(d)} of every month</option>`;
    }).join('');
    startSel.innerHTML = dayOptions;
    endSel.innerHTML = dayOptions + `<option value="31">Last Day of Month (28th–31st)</option>`;
    startSel.value = '1';
    endSel.value = '10';
};

const updateFeeScheduleLiveSummary = () => {
    const startSel = document.getElementById('fee-collect-start-day');
    const endSel = document.getElementById('fee-collect-end-day');
    const modeSel = document.getElementById('fee-notify-mode');
    const daysContainer = document.getElementById('fee-notify-days-container');
    const daysLabel = document.getElementById('fee-notify-days-label');
    const daysInput = document.getElementById('fee-notify-days-before');
    const badgeEl = document.getElementById('fee-collection-window-badge');
    const summaryTextEl = document.getElementById('fee-schedule-live-summary-text');

    if (!startSel || !endSel || !modeSel) return;

    const startDay = Math.min(31, Math.max(1, parseInt(startSel.value, 10) || 1));
    let endDay = Math.min(31, Math.max(1, parseInt(endSel.value, 10) || 10));
    if (endDay < startDay) {
        endDay = startDay;
        endSel.value = String(endDay);
    }

    const mode = modeSel.value || 'month_start';
    const daysBefore = Math.min(28, Math.max(1, parseInt(daysInput?.value, 10) || 5));

    const needsDaysInput = mode === 'days_before_end' || mode === 'days_before_month_end';
    if (daysContainer) daysContainer.classList.toggle('hidden', !needsDaysInput);
    if (daysLabel) {
        daysLabel.textContent = mode === 'days_before_end'
            ? 'Notify How Many Days Before Collection End Date?'
            : 'Notify How Many Days Before Month End?';
    }

    const startLabel = formatOrdinalDay(startDay);
    const endLabel = endDay === 31 ? 'Last Day (31st)' : formatOrdinalDay(endDay);
    if (badgeEl) {
        badgeEl.textContent = `Every Month: ${startLabel} to ${endLabel}`;
    }

    let alertTimingSummary = '';
    if (mode === 'month_start') {
        alertTimingSummary = `Student fee alert notifications start on the 1st of every month and continue daily until paid.`;
    } else if (mode === 'collection_start') {
        alertTimingSummary = `Student fee alert notifications start on the ${startLabel} of every month (Collection Start Date) and continue daily until paid.`;
    } else if (mode === 'days_before_end') {
        const triggerDay = Math.max(1, endDay - daysBefore);
        alertTimingSummary = `Student fee alert notifications start ${daysBefore} day(s) before the collection end date (from the ${formatOrdinalDay(triggerDay)} of every month) and continue daily until paid.`;
    } else if (mode === 'days_before_month_end') {
        alertTimingSummary = `Student fee alert notifications start ${daysBefore} day(s) before the end of each month and continue daily until paid.`;
    }

    if (summaryTextEl) {
        summaryTextEl.textContent = `Regular monthly fee collection runs from the ${startLabel} to the ${endLabel} of every month. ${alertTimingSummary}`;
    }
};

populateFeeCollectionScheduleSelectors();
['fee-collect-start-day', 'fee-collect-end-day', 'fee-notify-mode', 'fee-notify-days-before'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updateFeeScheduleLiveSummary);
    document.getElementById(id)?.addEventListener('input', updateFeeScheduleLiveSummary);
});
updateFeeScheduleLiveSummary();

document.getElementById('save-fee-config-btn').addEventListener('click', async () => {
    if(!requirePermission('fees.manage')) return;
    const startDay = Math.min(31, Math.max(1, parseInt(document.getElementById('fee-collect-start-day')?.value, 10) || 1));
    const endDay = Math.min(31, Math.max(startDay, parseInt(document.getElementById('fee-collect-end-day')?.value, 10) || 10));
    const notifyMode = document.getElementById('fee-notify-mode')?.value || 'month_start';
    const notifyDaysBefore = Math.min(28, Math.max(1, parseInt(document.getElementById('fee-notify-days-before')?.value, 10) || 5));

    if(!confirm("Save default fee settings?")) return;
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {
        defaultFee: parseInt(document.getElementById('default-fee-input').value) || 0,
        feeStatusTitle: document.getElementById('fee-status-title-input').value,
        defaultReceiptMandatory: document.getElementById('default-fee-receipt-req').checked,
        feeCollectionStartDay: startDay,
        feeCollectionEndDay: endDay,
        feeNotifyMode: notifyMode,
        feeNotifyDaysBefore: notifyDaysBefore
    }, {merge: true});
    await logAuditEvent({ category: 'fee', action: 'fee.config.save', entityType: 'settings', entityId: 'config', message: `Default fee configuration updated (Collection: Day ${startDay} to ${endDay}, Notify: ${notifyMode}).` });
    alert("Fee Configuration Saved!");
});

const renderFeeItemsManagement = () => {
    const cont = document.getElementById('fee-items-management-container');
    const activeYear = getActiveAcademicYearLabel();
    const scopedFeeItems = feeItems.filter((item) => (item.academicYear || activeYear) === activeYear);
    const monthlyItems = scopedFeeItems
        .filter((item) => (item.type || 'month') === 'month')
        .sort((a, b) => {
            const aMonth = (a.name || '').split('(')[0].trim().toLowerCase();
            const bMonth = (b.name || '').split('(')[0].trim().toLowerCase();
            const aIndex = MONTH_SEQUENCE.indexOf(aMonth);
            const bIndex = MONTH_SEQUENCE.indexOf(bMonth);
            if (aIndex === -1 && bIndex === -1) return (a.name || '').localeCompare(b.name || '');
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            return aIndex - bIndex;
        });
    const customItems = scopedFeeItems.filter((item) => item.type === 'custom');

    const renderMonthlyItemCard = (item) => {
        return `<div class="flex items-center justify-between p-3.5 bg-white border border-blue-100 hover:border-blue-300 rounded-xl shadow-2xs hover:shadow-xs transition drag-item" data-key="${item.key}">
            <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 text-xs shadow-2xs"><i class="fas fa-calendar-alt"></i></span>
                <span class="font-bold text-gray-800 text-sm truncate">${escapeHtml(item.name)}</span>
            </div>
            <span class="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-md text-[10px] font-bold uppercase tracking-wider shrink-0">Default</span>
        </div>`;
    };

    const renderItemCard = (item) => {
        let detailsHtml = '';
        if(item.type === 'custom') detailsHtml = `<div class="text-xs text-gray-500 mt-1">Scope: <span class="font-semibold text-blue-600 uppercase">${item.scope || 'GLOBAL'}</span> | Receipt Mandatory: <span class="font-semibold ${item.isReceiptMandatory ? 'text-red-500':'text-gray-400'}">${item.isReceiptMandatory ? 'YES':'NO'}</span></div>`;
        const handleHtml = item.type === 'custom'
            ? `<span class="drag-handle mr-4 text-gray-500 text-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg px-2 py-1 cursor-grab active:cursor-grabbing select-none" title="Drag to reorder"><i class="fas fa-grip-lines"></i></span>`
            : `<span class="mr-4 text-[10px] font-bold uppercase text-gray-400">Fixed</span>`;
        return `<div class="flex items-center bg-white border border-gray-200 p-4 rounded-xl shadow-sm drag-item transition hover:shadow-md" data-key="${item.key}">${handleHtml}<div class="flex-grow"><span class="font-bold text-gray-800 text-lg">${item.name}</span>${detailsHtml}</div>${item.type==='custom' ? `<button class="text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg text-sm font-bold transition edit-fee mr-2" data-key="${item.key}"><i class="fas fa-edit"></i></button><button class="text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-sm font-bold transition del-fee" data-key="${item.key}"><i class="fas fa-trash"></i></button>` : `<span class="px-3 py-1 bg-gray-100 text-gray-500 rounded-lg text-xs font-bold uppercase tracking-wider">Default Month</span>`}</div>`;
    };

    cont.innerHTML = `
        <div class="mb-5">
            <h4 class="text-sm font-bold text-blue-800 mb-2.5 uppercase tracking-wider flex items-center gap-2"><i class="fas fa-calendar-check text-blue-600"></i> Default Months (${escapeHtml(activeYear)})</h4>
            <div id="fee-items-monthly-list" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${monthlyItems.map(renderMonthlyItemCard).join('') || '<p class="text-xs text-gray-500 italic col-span-full">Monthly defaults are not available.</p>'}</div>
        </div>
        <div>
            <h4 class="text-sm font-bold text-emerald-800 mb-2.5 uppercase tracking-wider flex items-center gap-2"><i class="fas fa-layer-group text-emerald-600"></i> Other Fee Items (${escapeHtml(activeYear)})</h4>
            <div id="fee-items-custom-list" class="space-y-3">${customItems.map(renderItemCard).join('') || '<p class="text-xs text-gray-500 italic">No custom fee items added yet.</p>'}</div>
        </div>
    `;

    const persistFeeOrder = async () => {
        const orderedKeys = [
            ...Array.from(cont.querySelectorAll('#fee-items-monthly-list .drag-item')).map((el) => el.dataset.key),
            ...Array.from(cont.querySelectorAll('#fee-items-custom-list .drag-item')).map((el) => el.dataset.key)
        ];
        const orderedItems = orderedKeys.map((key) => feeItems.find((item) => item.key === key)).filter(Boolean);
        const remainingItems = feeItems.filter((item) => !orderedKeys.includes(item.key));
        const nextItems = [...orderedItems, ...remainingItems];
        if (orderedItems.length === 0) return;
        await setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), { feeItems: nextItems }, { merge: true });
    };

    const monthlyList = document.getElementById('fee-items-monthly-list');
    const customList = document.getElementById('fee-items-custom-list');
    const sortableOptions = {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        delay: 120,
        delayOnTouchOnly: true,
        touchStartThreshold: 8,
        fallbackTolerance: 6,
        forceFallback: true,
        onEnd: persistFeeOrder
    };
    if (customList && customItems.length > 1) new Sortable(customList, sortableOptions);
};

document.getElementById('fee-items-management-container').addEventListener('click', e => {
    const delBtn = e.target.closest('.del-fee'), editBtn = e.target.closest('.edit-fee');
    if(delBtn) {
        if(!confirm("Delete this fee item?")) return;
        setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {feeItems: feeItems.filter(i => i.key !== delBtn.dataset.key)}, {merge:true});
    }
    if(editBtn) {
        if(!requirePermission('fees.manage')) return;
        const item = feeItems.find(i => i.key === editBtn.dataset.key); if(!item) return;
        document.getElementById('e-fee-key').value = item.key; document.getElementById('e-fee-name').value = item.name;
        document.getElementById('e-fee-scope').value = item.scope || 'global';
        document.getElementById('e-fee-receipt-req').checked = item.isReceiptMandatory || false;

        document.getElementById('e-scope-global-container').classList.add('hidden'); document.getElementById('e-scope-class-wise-container').classList.add('hidden'); document.getElementById('e-scope-specific-container').classList.add('hidden');

        if(item.scope === 'global' || !item.scope) {
            document.getElementById('e-scope-global-container').classList.remove('hidden'); document.getElementById('e-fee-global-amt').value = item.amount || '';
        } else if(item.scope === 'class-wise') {
            document.getElementById('e-scope-class-wise-container').classList.remove('hidden');
            document.getElementById('e-class-wise-inputs').innerHTML = classes.map(c => `<div><label class="block text-xs font-bold text-gray-600 mb-1">${c}</label><input type="number" data-class="${c}" class="e-cw-input w-full p-2 border rounded text-sm font-medium" value="${item.classValues && item.classValues[c] ? item.classValues[c] : ''}"></div>`).join('');
        } else if(item.scope === 'specific') {
            document.getElementById('e-scope-specific-container').classList.remove('hidden');
            document.getElementById('e-fee-specific-class').innerHTML = classes.map(c => `<option value="${c}" ${item.targetClass===c?'selected':''}>${c}</option>`).join('');
            document.getElementById('e-fee-specific-amt').value = item.amount || '';
        }
        document.getElementById('edit-fee-popup').classList.remove('hidden'); document.getElementById('edit-fee-popup').classList.add('flex');
    }
});

document.getElementById('e-fee-scope').addEventListener('change', (e) => {
    const val = e.target.value;
    document.getElementById('e-scope-global-container').classList.toggle('hidden', val !== 'global');
    document.getElementById('e-scope-class-wise-container').classList.toggle('hidden', val !== 'class-wise');
    document.getElementById('e-scope-specific-container').classList.toggle('hidden', val !== 'specific');
    if(val === 'class-wise') document.getElementById('e-class-wise-inputs').innerHTML = classes.map(c => `<div><label class="block text-xs font-bold text-gray-600 mb-1">${c}</label><input type="number" data-class="${c}" class="e-cw-input w-full p-2 border rounded text-sm font-medium"></div>`).join('');
    if(val === 'specific') document.getElementById('e-fee-specific-class').innerHTML = classes.map(c => `<option value="${c}">${c}</option>`).join('');
});

document.getElementById('e-fee-cancel').onclick = () => document.getElementById('edit-fee-popup').classList.add('hidden');
document.getElementById('e-fee-update').onclick = () => {
    if(!requirePermission('fees.manage')) return;
    const key = document.getElementById('e-fee-key').value, name = document.getElementById('e-fee-name').value.trim(), scope = document.getElementById('e-fee-scope').value;
    if(!name) return alert("Name is mandatory.");
    if(!confirm("Save changes to this fee item?")) return;

    const existingFee = feeItems.find(f => f.key === key) || {};
    let updatedFee = {
        ...existingFee,
        key,
        name,
        type: 'custom',
        isVisible: true,
        scope,
        isReceiptMandatory: document.getElementById('e-fee-receipt-req').checked,
        academicYear: existingFee.academicYear || getActiveAcademicYearLabel(),
        createdAt: existingFee.createdAt || new Date().toISOString(),
        timestamp: existingFee.timestamp || Date.now()
    };

    if(scope === 'global') {
        const amt = parseFloat(document.getElementById('e-fee-global-amt').value); if(isNaN(amt)) return alert("Enter valid amount"); updatedFee.amount = amt;
    } else if(scope === 'class-wise') {
        let classAmounts = {}; document.querySelectorAll('.e-cw-input').forEach(inp => { const amt = parseFloat(inp.value); if(!isNaN(amt)) classAmounts[inp.dataset.class] = amt; });
        if(Object.keys(classAmounts).length === 0) return alert("Enter amount for at least one class"); updatedFee.classValues = classAmounts;
    } else if(scope === 'specific') {
        const targetCls = document.getElementById('e-fee-specific-class').value, amt = parseFloat(document.getElementById('e-fee-specific-amt').value);
        if(!targetCls || isNaN(amt)) return alert("Select class and enter valid amount"); updatedFee.targetClass = targetCls; updatedFee.amount = amt;
    }

    const newFees = feeItems.map(f => f.key === key ? updatedFee : f);
    setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {feeItems: newFees}, {merge:true});
    logAuditEvent({ category: 'fee', action: 'fee.update', entityType: 'feeItem', entityId: key, message: `Fee item updated: ${name}.` });
    document.getElementById('edit-fee-popup').classList.add('hidden');
};

// --- 8. WEBSITE BASIC INFO ---
document.getElementById('save-web-info-btn').addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    if(!confirm("Save website information?")) return;
    const btn = document.getElementById('save-web-info-btn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const getInputValue = (id, transform = (value) => value) => {
            const element = document.getElementById(id);
            if (!element) return '';
            return transform(String(element.value ?? ''));
        };

        await setDoc(doc(db, `${BASE_PATH}/settings`, 'config'), {
            appName: getInputValue('app-name-input'),
            appSubtitle: getInputValue('app-subtitle-input'),
            logoUrl: getInputValue('web-logo'),
            contactPhone: getInputValue('web-phone'),
            contactEmail: getInputValue('web-email'),
            socialWhatsapp: getInputValue('web-wa'),
            socialFacebook: getInputValue('web-fb'),
            socialInstagram: getInputValue('web-ig'),
            socialTelegram: getInputValue('web-tg'),
            socialYouTube: getInputValue('web-yt'),
            regNo: getInputValue('web-regno', (value) => value.trim()),
            place: getInputValue('web-place', (value) => value.trim()),
            paymentAccountName: getInputValue('pay-account-name', (value) => value.trim()),
            paymentUpiNumber: getInputValue('pay-upi-number', (value) => value.trim()),
            paymentUpiId: getInputValue('pay-upi-id', (value) => value.trim()),
            paymentBankName: getInputValue('pay-bank-name', (value) => value.trim()),
            paymentAccountNumber: getInputValue('pay-account-number', (value) => value.trim()),
            paymentIfsc: getInputValue('pay-ifsc', (value) => value.trim().toUpperCase()),
            paymentBranch: getInputValue('pay-branch', (value) => value.trim()),
            paymentUpiName: getInputValue('pay-account-name', (value) => value.trim())
        }, {merge: true});
        await setDoc(doc(db, `${BASE_PATH}/settings`, 'content'), { description: getInputValue('web-about') }, {merge: true});
        await logAuditEvent({ category: 'website', action: 'website.info.save', entityType: 'settings', entityId: 'config', message: 'Website basic information updated.' });
        alert("Basic Info Updated!");
    } catch (error) {
        console.error('Failed to save website basic info.', error);
        alert(`Save failed: ${error?.message || 'Please check Firestore rules and admin permissions.'}`);
    } finally {
        btn.innerHTML = '<i class="fas fa-save mr-2"></i> Save Info';
        btn.disabled = false;
    }
});

// --- 9 & 10. NOTICES & GALLERY ---
const updateWebContent = async () => { await setDoc(doc(db, `${BASE_PATH}/settings`, 'content'), webContent, {merge: true}); }
const expandedNoticeIndexes = new Set();

const renderAdminNoticeTextWithLinks = (rawText = '', linkLabelLength = 35) => {
    const text = String(rawText || '');
    if (!text) return '';
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    let cursor = 0;
    let html = '';
    text.replace(urlPattern, (url, _unused, offset) => {
        const leading = text.slice(cursor, offset);
        html += escapeHtml(leading);
        const safeHref = sanitizeUrl(url, ['https:', 'http:']);
        if (safeHref) {
            const shortLabel = url.length > linkLabelLength
                ? `${url.slice(0, linkLabelLength)}...`
                : url;
            html += `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-semibold break-all">${escapeHtml(shortLabel)}</a>`;
        } else {
            html += escapeHtml(url);
        }
        cursor = offset + url.length;
        return url;
    });
    html += escapeHtml(text.slice(cursor));
    return html.replace(/\n/g, '<br>');
};

const normalizeNoticePayload = (notice = {}, previous = {}) => {
    const now = Date.now();
    const wasPinned = previous.pinned === true;
    const isPinned = notice.pinned === true;
    const rawImage = notice.image !== undefined
        ? String(notice.image || '').trim()
        : String(notice.imageUrl || previous.image || previous.imageUrl || '').trim();
    return {
        id: previous.id || notice.id || `notice-${now}-${Math.random().toString(36).slice(2, 8)}`,
        heading: String(notice.heading || '').trim(),
        text: String(notice.text || '').trim(),
        image: rawImage,
        date: String(notice.date || '').trim(),
        pinned: isPinned,
        createdAt: previous.createdAt || notice.createdAt || now,
        updatedAt: now,
        pinnedAt: isPinned ? (wasPinned ? (previous.pinnedAt || notice.pinnedAt || now) : now) : ''
    };
};

const updateNoticeImagePreviewUI = (prefix, imageSrc = '') => {
    const preview = document.getElementById(`${prefix}-img-preview`);
    const placeholder = document.getElementById(`${prefix}-img-placeholder`);
    const clearBtn = document.getElementById(`${prefix}-img-clear-btn`);
    const fileInput = document.getElementById(`${prefix}-img-file`);
    const dataInput = document.getElementById(`${prefix}-img-data`);
    const cleanSrc = String(imageSrc || '').trim();

    if (dataInput) dataInput.value = cleanSrc;
    if (fileInput && !cleanSrc) fileInput.value = '';
    if (cleanSrc) {
        if (preview) {
            preview.src = cleanSrc;
            preview.classList.remove('hidden');
        }
        if (placeholder) placeholder.classList.add('hidden');
        if (clearBtn) clearBtn.classList.remove('hidden');
    } else {
        if (preview) {
            preview.src = '';
            preview.classList.add('hidden');
        }
        if (placeholder) placeholder.classList.remove('hidden');
        if (clearBtn) clearBtn.classList.add('hidden');
    }
};

const initNoticeUploadControls = () => {
    const bindNoticeUploader = (prefix) => {
        const uploadBtn = document.getElementById(`${prefix}-img-upload-btn`);
        const fileInput = document.getElementById(`${prefix}-img-file`);
        const clearBtn = document.getElementById(`${prefix}-img-clear-btn`);
        if (!uploadBtn || !fileInput) return;

        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const originalLabel = uploadBtn.innerHTML;
            try {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Compressing...';
                const base64 = await compressImageFileToBase64(file, 60);
                updateNoticeImagePreviewUI(prefix, base64);
            } catch (err) {
                console.error('Notice image compression failed:', err);
                alert('Unable to compress image: ' + (err?.message || 'Error'));
            } finally {
                uploadBtn.disabled = false;
                uploadBtn.innerHTML = originalLabel;
                fileInput.value = '';
            }
        });

        clearBtn?.addEventListener('click', () => {
            updateNoticeImagePreviewUI(prefix, '');
        });
    };

    bindNoticeUploader('new-notice');
    bindNoticeUploader('e-not');
};

const renderWebNotices = () => {
    const list = document.getElementById('web-notices-list');
    list.innerHTML = webContent.notices.length === 0
        ? '<p class="text-sm italic text-gray-500 p-2 col-span-full">No active notices.</p>'
        : webContent.notices.map((notice, i) => {
            const n = normalizeNoticePayload(notice);
            const safeImg = (n.image && n.image.startsWith('data:image/')) ? n.image : sanitizeUrl(n.image);
            const hasHeading = Boolean(n.heading);
            const hasText = Boolean(n.text);
            return `
            <div class="flex flex-col justify-between p-3.5 bg-white border border-gray-200 rounded-xl shadow-2xs hover:shadow-md hover:border-blue-200 text-sm transition">
                <div class="text-gray-800 font-medium min-w-0 w-full break-words">
                    <!-- Top bar: Date & Badges on left, Edit & Delete buttons on right -->
                    <div class="flex items-center justify-between gap-1.5 mb-2 pb-2 border-b border-gray-100">
                        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                            <span class="inline-flex bg-blue-100 text-blue-800 px-2 py-0.5 rounded-md font-bold font-mono text-[11px]">${escapeHtml(n.date || '--')}</span>
                            ${n.pinned ? '<span class="inline-flex bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-md font-bold text-[10px]"><i class="fas fa-thumbtack mr-1"></i>Pinned</span>' : ''}
                            ${safeImg ? '<span class="inline-flex bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-md font-bold text-[10px]"><i class="fas fa-image mr-1"></i>Image</span>' : ''}
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <button class="text-blue-600 bg-blue-50 hover:bg-blue-100 w-7 h-7 rounded-lg flex items-center justify-center transition notice-action-btn" data-action="edit" data-index="${i}" title="Edit notice"><i class="fas fa-edit text-xs"></i></button>
                            <button class="text-red-600 bg-red-50 hover:bg-red-100 w-7 h-7 rounded-lg flex items-center justify-center transition notice-action-btn" data-action="delete" data-index="${i}" title="Delete notice"><i class="fas fa-trash text-xs"></i></button>
                        </div>
                    </div>

                    ${hasHeading ? `<div class="font-extrabold text-gray-900 mb-1.5 text-sm line-clamp-2">${escapeHtml(n.heading)}</div>` : (!hasText && safeImg ? `<div class="text-xs font-bold text-slate-400 italic mb-1.5">Image-only Notice</div>` : '')}
                    ${safeImg ? `<div class="my-2"><img src="${safeImg}" alt="${escapeHtml(n.heading || 'Notice image')}" class="max-h-36 w-full rounded-lg border border-slate-200 object-cover bg-slate-50 shadow-xs"></div>` : ''}
                    ${hasText ? `<div class="text-xs break-words leading-relaxed text-slate-700 ${expandedNoticeIndexes.has(i) ? '' : 'overflow-hidden'}" style="${expandedNoticeIndexes.has(i) ? '' : 'max-height: 4.5em;'}">${renderAdminNoticeTextWithLinks(n.text, 25)}</div>` : ''}
                    ${(n.text || '').length > 100 ? `<button class="text-[11px] font-bold text-blue-700 mt-1.5 notice-toggle-btn" data-index="${i}">${expandedNoticeIndexes.has(i) ? 'Collapse' : 'Expand'}</button>` : ''}
                </div>
            </div>
        `;
        }).join('');
    const noticeDateInput = document.getElementById('new-notice-dt');
    if (noticeDateInput && !noticeDateInput.value) {
        noticeDateInput.value = new Date().toISOString().split('T')[0];
    }
};
document.getElementById('add-notice-btn').onclick = () => {
    if(!requirePermission('website.manage')) return;
    const heading = document.getElementById('new-notice-head').value.trim();
    const txt = document.getElementById('new-notice-txt').value.trim();
    const image = document.getElementById('new-notice-img-data')?.value?.trim() || '';
    const dt = document.getElementById('new-notice-dt').value || new Date().toISOString().split('T')[0];
    const pinned = document.getElementById('new-notice-pin').checked;
    if (!heading && !txt && !image) {
        alert("Please provide at least a title, description, or image.");
        return;
    }
    if(dt) {
        if(!confirm("Publish new notice?")) return;
        expandedNoticeIndexes.clear();
        webContent.notices.push(normalizeNoticePayload({ heading, text: txt, image, date: dt, pinned }));
        updateWebContent();
        logAuditEvent({ category: 'website', action: 'notice.create', entityType: 'notice', message: 'Website notice published.' });
        document.getElementById('new-notice-head').value = '';
        document.getElementById('new-notice-txt').value = '';
        updateNoticeImagePreviewUI('new-notice', '');
        document.getElementById('new-notice-pin').checked = false;
        document.getElementById('new-notice-dt').value = new Date().toISOString().split('T')[0];
    }
};
window.deleteNotice = (idx) => { if(!requirePermission('website.manage')) return; if(!confirm("Delete this notice?")) return; expandedNoticeIndexes.clear(); webContent.notices.splice(idx, 1); updateWebContent(); logAuditEvent({ category: 'website', action: 'notice.delete', entityType: 'notice', entityId: String(idx), message: 'Website notice deleted.' }); };
window.editNotice = (idx) => {
    if(!requirePermission('website.manage')) return;
    const n = normalizeNoticePayload(webContent.notices[idx] || {}); document.getElementById('e-not-idx').value = idx;
    document.getElementById('e-not-head').value = n.heading;
    document.getElementById('e-not-txt').value = n.text;
    document.getElementById('e-not-dt').value = n.date || new Date().toISOString().split('T')[0];
    document.getElementById('e-not-pin').checked = n.pinned;
    updateNoticeImagePreviewUI('e-not', n.image || '');
    document.getElementById('edit-notice-popup').classList.remove('hidden'); document.getElementById('edit-notice-popup').classList.add('flex');
};
document.getElementById('e-not-cancel').onclick = () => {
    document.getElementById('edit-notice-popup').classList.add('hidden');
    document.getElementById('edit-notice-popup').classList.remove('flex');
};
document.getElementById('e-not-save').onclick = () => {
    if(!requirePermission('website.manage')) return;
    const idx = document.getElementById('e-not-idx').value;
    const heading = document.getElementById('e-not-head').value.trim();
    const txt = document.getElementById('e-not-txt').value.trim();
    const image = document.getElementById('e-not-img-data')?.value?.trim() || '';
    const dt = document.getElementById('e-not-dt').value || new Date().toISOString().split('T')[0];
    const pinned = document.getElementById('e-not-pin').checked;
    if (!heading && !txt && !image) {
        alert("Please provide at least a title, description, or image.");
        return;
    }
    if(dt) {
        if(!confirm("Save changes to this notice?")) return;
        expandedNoticeIndexes.clear();
        webContent.notices[idx] = normalizeNoticePayload({ heading, text: txt, image, date: dt, pinned }, webContent.notices[idx] || {});
        updateWebContent();
        logAuditEvent({ category: 'website', action: 'notice.update', entityType: 'notice', entityId: String(idx), message: 'Website notice updated.' });
        document.getElementById('edit-notice-popup').classList.add('hidden');
        document.getElementById('edit-notice-popup').classList.remove('flex');
    }
};

const normalizeGalleryItem = (item = {}, index = 0) => {
    if (typeof item === 'string') {
        return { url: item.trim(), order: 50 + index };
    }
    const parsedOrder = Number(item?.order);
    return {
        url: String(item?.url || item?.imageUrl || item?.src || '').trim(),
        order: Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : 50 + index
    };
};

const normalizeGalleryList = () => {
    webContent.gallery = Array.isArray(webContent.gallery) ? webContent.gallery.map(normalizeGalleryItem) : [];
};

const getNextGalleryOrder = () => {
    if (!webContent.gallery || webContent.gallery.length === 0) return 50;
    const existingOrders = webContent.gallery
        .map(item => Number(item.order))
        .filter(n => Number.isFinite(n) && n >= 50);
    if (existingOrders.length === 0) return 50;
    return Math.max(...existingOrders) + 1;
};

let selectedGalleryFiles = [];

const resetNewGalleryUploadForm = () => {
    selectedGalleryFiles.forEach((item) => {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(item.previewUrl); } catch (_err) {}
        }
    });
    selectedGalleryFiles = [];

    const fileInput = document.getElementById('new-gal-file');
    const dataInput = document.getElementById('new-gal-data');
    const orderInput = document.getElementById('new-gal-order');
    const queueContainer = document.getElementById('new-gal-queue-container');
    const thumbnailsContainer = document.getElementById('new-gal-thumbnails');
    const queueCountEl = document.getElementById('new-gal-queue-count');
    const statusEl = document.getElementById('new-gal-status');
    const progressBarContainer = document.getElementById('new-gal-progress-bar-container');
    const progressBar = document.getElementById('new-gal-progress-bar');
    const addBtn = document.getElementById('add-gal-btn');
    const addBtnText = document.getElementById('add-gal-btn-text');

    if (fileInput) fileInput.value = '';
    if (dataInput) dataInput.value = '';
    if (orderInput) orderInput.value = getNextGalleryOrder();
    if (queueContainer) queueContainer.classList.add('hidden');
    if (thumbnailsContainer) thumbnailsContainer.innerHTML = '';
    if (queueCountEl) queueCountEl.textContent = '0';
    if (statusEl) statusEl.textContent = 'Ready to upload. Order numbers will automatically increment.';
    if (progressBarContainer) progressBarContainer.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (addBtn) addBtn.disabled = false;
    if (addBtnText) addBtnText.textContent = 'Upload All Photos';
};

const renderGallerySelectedThumbnails = () => {
    const thumbnailsContainer = document.getElementById('new-gal-thumbnails');
    const queueContainer = document.getElementById('new-gal-queue-container');
    const queueCountEl = document.getElementById('new-gal-queue-count');
    const addBtnText = document.getElementById('add-gal-btn-text');
    const orderInput = document.getElementById('new-gal-order');

    if (!thumbnailsContainer || !queueContainer) return;

    if (selectedGalleryFiles.length === 0) {
        resetNewGalleryUploadForm();
        return;
    }

    queueContainer.classList.remove('hidden');
    if (queueCountEl) queueCountEl.textContent = String(selectedGalleryFiles.length);
    if (addBtnText) addBtnText.textContent = `Upload All (${selectedGalleryFiles.length} Photos)`;

    const startOrder = Number(orderInput?.value) || getNextGalleryOrder();

    thumbnailsContainer.innerHTML = selectedGalleryFiles.map((item, idx) => {
        const assignedOrder = startOrder + idx;
        const sizeKb = Math.round(item.file.size / 1024);
        return `
            <div class="relative group bg-white rounded-lg border border-slate-200 overflow-hidden shadow-2xs p-1 flex flex-col justify-between">
                <div class="relative h-20 w-full overflow-hidden rounded bg-slate-100 flex items-center justify-center">
                    <img src="${item.previewUrl}" class="w-full h-full object-cover" alt="Selected photo ${idx + 1}">
                    <span class="absolute top-1 left-1 bg-black/70 text-white font-mono text-[9px] px-1.5 py-0.5 rounded font-bold">#${assignedOrder}</span>
                    <button type="button" class="remove-queue-file-btn absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600/90 hover:bg-red-700 text-white flex items-center justify-center text-[10px] shadow transition" data-id="${item.id}" title="Remove photo" aria-label="Remove photo">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="mt-1 px-0.5 flex items-center justify-between text-[10px] text-slate-500 font-medium">
                    <span class="truncate max-w-[65px]" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
                    <span class="font-mono text-[9px] shrink-0 text-slate-400">${sizeKb} KB</span>
                </div>
            </div>
        `;
    }).join('');
};

const handleSelectedGalleryFiles = (files) => {
    if (!files || files.length === 0) return;
    const orderInput = document.getElementById('new-gal-order');
    if (orderInput && (!orderInput.value || Number(orderInput.value) < 1)) {
        orderInput.value = getNextGalleryOrder();
    }
    Array.from(files).forEach((file) => {
        if (!file.type.startsWith('image/')) return;
        const id = `gal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const previewUrl = URL.createObjectURL(file);
        selectedGalleryFiles.push({ file, previewUrl, id });
    });
    renderGallerySelectedThumbnails();
};

const renderWebGallery = () => {
    normalizeGalleryList();
    const orderInput = document.getElementById('new-gal-order');
    if (orderInput && (!orderInput.value || Number(orderInput.value) < 50)) {
        orderInput.value = getNextGalleryOrder();
    }
    const galleryListEl = document.getElementById('web-gallery-list');
    if (!galleryListEl) return;

    galleryListEl.innerHTML = webContent.gallery.length === 0 ? '<p class="col-span-full text-sm italic text-gray-500 p-2">Gallery is empty.</p>' : webContent.gallery.map((item, i) => {
        const safeUrl = sanitizeUrl(item.url) || 'https://via.placeholder.com/320x180?text=Image';
        const orderValue = Number.isFinite(Number(item.order)) ? Number(item.order) : 50 + i;
        return `<div class="relative rounded-xl overflow-hidden shadow-sm border border-gray-200 bg-white">
            <img src="${safeUrl}" class="w-full h-32 object-cover" alt="Gallery image ${i + 1}">
            <div class="p-3 space-y-1.5 bg-gray-50/50 border-t">
                <div class="flex items-center justify-between">
                    <label class="block text-xs font-bold text-gray-600" for="gal-order-${i}">Order:</label>
                    <span class="text-xs font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">${escapeHtml(String(orderValue))}</span>
                </div>
                <input type="number" id="gal-order-${i}" class="gallery-order-input w-full p-1.5 border rounded-lg text-xs font-bold text-center" min="1" step="1" value="${escapeHtml(String(orderValue))}" data-index="${i}" aria-label="Gallery image ${i + 1} display order">
            </div>
            <div class="absolute top-2 right-2 flex items-center gap-1.5">
                <button class="bg-blue-600 hover:bg-blue-700 text-white rounded-lg w-8 h-8 flex items-center justify-center shadow-md transition gallery-action-btn" data-action="edit" data-index="${i}" aria-label="Edit image" title="Edit Photo & Order"><i class="fas fa-edit text-xs"></i></button>
                <button class="bg-red-600 hover:bg-red-700 text-white rounded-lg w-8 h-8 flex items-center justify-center shadow-md transition gallery-action-btn" data-action="delete" data-index="${i}" aria-label="Delete image" title="Delete Photo"><i class="fas fa-trash text-xs"></i></button>
            </div>
        </div>`;
    }).join('');
};

const initGalleryUploadControls = () => {
    const dropzone = document.getElementById('new-gal-dropzone');
    const fileInput = document.getElementById('new-gal-file');
    const clearBtn = document.getElementById('new-gal-clear-btn');
    const orderInput = document.getElementById('new-gal-order');
    const thumbnailsContainer = document.getElementById('new-gal-thumbnails');

    dropzone?.addEventListener('click', (e) => {
        if (e.target !== fileInput) fileInput?.click();
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('border-blue-500', 'bg-blue-100/50');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('border-blue-500', 'bg-blue-100/50');
        });
    });

    dropzone?.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt?.files;
        if (files && files.length) {
            handleSelectedGalleryFiles(files);
        }
    });

    fileInput?.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
            handleSelectedGalleryFiles(e.target.files);
        }
    });

    orderInput?.addEventListener('input', () => {
        if (selectedGalleryFiles.length > 0) {
            renderGallerySelectedThumbnails();
        }
    });

    thumbnailsContainer?.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.remove-queue-file-btn');
        if (!removeBtn) return;
        const id = removeBtn.dataset.id;
        const idx = selectedGalleryFiles.findIndex(item => item.id === id);
        if (idx !== -1) {
            const removed = selectedGalleryFiles.splice(idx, 1)[0];
            if (removed?.previewUrl?.startsWith('blob:')) {
                try { URL.revokeObjectURL(removed.previewUrl); } catch (_err) {}
            }
            renderGallerySelectedThumbnails();
        }
    });

    clearBtn?.addEventListener('click', () => {
        resetNewGalleryUploadForm();
    });

    document.getElementById('add-gal-btn')?.addEventListener('click', async () => {
        if (!requirePermission('website.manage')) return;
        if (selectedGalleryFiles.length === 0) {
            alert("Please select at least one photo.");
            return;
        }

        const count = selectedGalleryFiles.length;
        if (!confirm(`Upload ${count} photo${count > 1 ? 's' : ''} to gallery? Photos will be compressed to 75KB with sequential display orders.`)) return;

        const addBtn = document.getElementById('add-gal-btn');
        const addBtnText = document.getElementById('add-gal-btn-text');
        const statusEl = document.getElementById('new-gal-status');
        const progressBarContainer = document.getElementById('new-gal-progress-bar-container');
        const progressBar = document.getElementById('new-gal-progress-bar');
        const clearBtnEl = document.getElementById('new-gal-clear-btn');

        if (addBtn) addBtn.disabled = true;
        if (clearBtnEl) clearBtnEl.disabled = true;
        if (progressBarContainer) progressBarContainer.classList.remove('hidden');

        normalizeGalleryList();
        let startOrder = Number(document.getElementById('new-gal-order')?.value);
        if (!Number.isFinite(startOrder) || startOrder < 1) startOrder = getNextGalleryOrder();

        const uploadedItems = [];
        let errors = 0;

        for (let i = 0; i < selectedGalleryFiles.length; i++) {
            const item = selectedGalleryFiles[i];
            const order = startOrder + i;
            const progressPercent = Math.round((i / count) * 100);
            if (progressBar) progressBar.style.width = `${progressPercent}%`;
            if (statusEl) statusEl.textContent = `Compressing and uploading photo ${i + 1} of ${count}...`;
            if (addBtnText) addBtnText.textContent = `Processing ${i + 1}/${count}...`;

            try {
                // Compress to max 75KB
                const base64 = await compressImageFileToBase64(item.file, 75);
                uploadedItems.push({ url: base64, order });
            } catch (err) {
                console.error(`Failed to compress gallery image ${i + 1}:`, err);
                errors++;
            }
        }

        if (progressBar) progressBar.style.width = '100%';

        if (uploadedItems.length > 0) {
            webContent.gallery.push(...uploadedItems);
            await updateWebContent();
            logAuditEvent({
                category: 'website',
                action: 'gallery.batch_create',
                entityType: 'gallery',
                message: `Batch added ${uploadedItems.length} photos starting with order ${startOrder}.`
            });
            showToast?.(`Successfully uploaded ${uploadedItems.length} photos!`, 'success');
        }

        if (errors > 0) {
            alert(`${errors} photo(s) could not be compressed or uploaded.`);
        }

        resetNewGalleryUploadForm();
        renderWebGallery();
    });

    document.getElementById('edit-gal-close-btn')?.addEventListener('click', () => {
        document.getElementById('edit-gallery-popup').classList.add('hidden');
        document.getElementById('edit-gallery-popup').classList.remove('flex');
    });
    document.getElementById('edit-gal-cancel-btn')?.addEventListener('click', () => {
        document.getElementById('edit-gallery-popup').classList.add('hidden');
        document.getElementById('edit-gallery-popup').classList.remove('flex');
    });

    const editChangeBtn = document.getElementById('edit-gal-change-btn');
    const editFileInput = document.getElementById('edit-gal-file');
    editChangeBtn?.addEventListener('click', () => editFileInput?.click());

    editFileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            editChangeBtn.disabled = true;
            editChangeBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Compressing...';
            const base64 = await compressImageFileToBase64(file, 75);
            document.getElementById('edit-gal-data').value = base64;
            document.getElementById('edit-gal-preview').src = base64;
        } catch (err) {
            console.error('Edit gallery photo compression failed:', err);
            alert('Unable to compress image.');
        } finally {
            editChangeBtn.disabled = false;
            editChangeBtn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i> Change Photo';
        }
    });

    document.getElementById('edit-gal-save-btn')?.addEventListener('click', () => {
        if (!requirePermission('website.manage')) return;
        const idx = Number(document.getElementById('edit-gal-idx')?.value);
        if (!Number.isFinite(idx) || !webContent.gallery[idx]) return;

        const newOrder = Number(document.getElementById('edit-gal-order')?.value);
        const order = Number.isFinite(newOrder) && newOrder > 0 ? newOrder : (webContent.gallery[idx].order || 50);
        const newData = document.getElementById('edit-gal-data')?.value;

        if (!confirm("Save changes?")) return;
        normalizeGalleryList();
        const updated = Object.assign({}, webContent.gallery[idx], { order });
        if (newData) {
            updated.url = newData;
        }
        webContent.gallery[idx] = updated;
        updateWebContent();
        logAuditEvent({ category: 'website', action: 'gallery.update', entityType: 'gallery', entityId: String(idx), message: `Gallery item ${idx} updated with order ${order}.` });
        document.getElementById('edit-gallery-popup').classList.add('hidden');
        document.getElementById('edit-gallery-popup').classList.remove('flex');
        renderWebGallery();
    });
};

window.deleteGal = (idx) => { if(!requirePermission('website.manage')) return; if(!confirm("Delete this image?")) return; normalizeGalleryList(); webContent.gallery.splice(idx, 1); updateWebContent(); logAuditEvent({ category: 'website', action: 'gallery.delete', entityType: 'gallery', entityId: String(idx), message: 'Gallery image deleted.' }); renderWebGallery(); };

window.editGal = (idx) => {
    if (!requirePermission('website.manage')) return;
    normalizeGalleryList();
    const item = webContent.gallery[idx];
    if (!item) return;

    document.getElementById('edit-gal-idx').value = idx;
    document.getElementById('edit-gal-order').value = item.order || (50 + idx);
    document.getElementById('edit-gal-preview').src = item.url || '';
    document.getElementById('edit-gal-data').value = '';
    const modal = document.getElementById('edit-gallery-popup');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

const updateGalleryOrder = (idx, value) => {
    if(!requirePermission('website.manage')) return;
    normalizeGalleryList();
    const parsedOrder = Number(value);
    if(!Number.isFinite(parsedOrder) || parsedOrder <= 0 || !webContent.gallery[idx]) {
        renderWebGallery();
        return;
    }
    webContent.gallery[idx] = Object.assign({}, webContent.gallery[idx], { order: parsedOrder });
    updateWebContent();
    logAuditEvent({ category: 'website', action: 'gallery.order.update', entityType: 'gallery', entityId: String(idx), message: 'Gallery image order updated.' });
};

document.getElementById('web-notices-page').addEventListener('click', (e) => {
    const button = e.target.closest('.notice-action-btn');
    const toggleBtn = e.target.closest('.notice-toggle-btn');
    if (toggleBtn) {
        const idx = Number(toggleBtn.dataset.index);
        if (expandedNoticeIndexes.has(idx)) expandedNoticeIndexes.delete(idx);
        else expandedNoticeIndexes.add(idx);
        renderWebNotices();
        return;
    }
    if (!button) return;
    if (button.dataset.action === 'edit') window.editNotice(Number(button.dataset.index));
    if (button.dataset.action === 'delete') window.deleteNotice(Number(button.dataset.index));
});
document.getElementById('web-gallery-page').addEventListener('click', (e) => {
    const button = e.target.closest('.gallery-action-btn');
    if (!button) return;
    if (button.dataset.action === 'edit') window.editGal(Number(button.dataset.index));
    if (button.dataset.action === 'delete') window.deleteGal(Number(button.dataset.index));
});
document.getElementById('web-gallery-page').addEventListener('change', (e) => {
    const input = e.target.closest('.gallery-order-input');
    if (!input) return;
    updateGalleryOrder(Number(input.dataset.index), input.value);
});

// --- 10B. DYNAMIC DIRECTORY CATEGORIES ---
const normalizeDirectoryField = (field = {}) => ({
    id: String(field.id || `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
    label: String(field.label || '').trim(),
    key: String(field.key || String(field.label || '').trim().toLowerCase().replace(/[^\w]+/g, '_')),
    type: String(field.type || 'text').trim(),
    required: field.required === true,
    order: Math.max(1, Number(field.order) || 1),
    locked: field.locked === true
});
const DIRECTORY_CORE_FIELDS = [
    { id: 'core_name', label: 'Name', key: 'name', type: 'text', required: true, order: 1, locked: true },
    { id: 'core_role', label: 'Role', key: 'role', type: 'text', required: false, order: 2, locked: true },
    { id: 'core_photo', label: 'Photo', key: 'photo', type: 'text', required: false, order: 3, locked: true },
    { id: 'core_phone', label: 'Phone Number', key: 'phone', type: 'phone', required: false, order: 4, locked: true },
    { id: 'core_address', label: 'Address', key: 'address', type: 'textarea', required: false, order: 5, locked: true }
];
const ensureDefaultDirectoryFields = (fields = null) => {
    if (!Array.isArray(fields) || fields.length === 0) {
        return DIRECTORY_CORE_FIELDS.map(normalizeDirectoryField);
    }
    const incoming = fields.map(normalizeDirectoryField);
    // Ensure core 'name' is always present as base identifier
    if (!incoming.some((field) => field.key === 'name')) {
        incoming.unshift(normalizeDirectoryField({ id: 'core_name', label: 'Name', key: 'name', type: 'text', required: true, order: 1, locked: true }));
    }
    return incoming.sort((a, b) => a.order - b.order);
};
const normalizeDirectoryCategory = (category = {}) => ({
    id: String(category.id || `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
    name: String(category.name || '').trim(),
    order: Math.max(1, Number(category.order) || 1),
    showPublic: category.showPublic !== false,
    fields: ensureDefaultDirectoryFields(category.fields || [])
});
const normalizeCategoryAuthConfig = (payload = {}) => ({
    categories: payload && typeof payload.categories === 'object' && payload.categories !== null ? payload.categories : {}
});
const normalizePageAccessConfig = (payload = {}) => ({
    categories: payload && typeof payload.categories === 'object' && payload.categories !== null ? payload.categories : {},
    overrides: payload && typeof payload.overrides === 'object' && payload.overrides !== null ? payload.overrides : {}
});
const hashCredentialValue = async (rawValue = '') => {
    const value = String(rawValue || '');
    if (!value) return '';
    if (!(window.crypto?.subtle)) return value;
    const encoded = new TextEncoder().encode(value);
    const digest = await window.crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const getCategoryAuthItem = (categoryId = '') => {
    const raw = categoryAuthConfig?.categories?.[categoryId] || {};
    return {
        enabled: raw.enabled === true,
        mode: raw.mode === 'mapped' ? 'mapped' : 'manual',
        targetPage: raw.targetPage === 'student' ? 'student' : 'collection',
        usernameField: String(raw.usernameField || ''),
        passwordField: String(raw.passwordField || '')
    };
};
const getPageAccessCategoryItem = (categoryId = '') => {
    const raw = pageAccessConfig?.categories?.[categoryId] || {};
    return {
        collection: raw.collection === true,
        student: raw.student === true
    };
};
const updateCategoryAuthConfig = async (nextConfig = {}) => {
    categoryAuthConfig = normalizeCategoryAuthConfig(nextConfig);
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'categoryAuthConfig'), categoryAuthConfig, { merge: false });
};
const updatePageAccessConfig = async (nextConfig = {}) => {
    pageAccessConfig = normalizePageAccessConfig(nextConfig);
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'pageAccess'), pageAccessConfig, { merge: false });
};
const getDirectoryCategories = () => (Array.isArray(webContent.directoryCategories) ? webContent.directoryCategories : []).map(normalizeDirectoryCategory).sort((a, b) => a.order - b.order);
const renderDirectoryCategoryOptions = () => {
    const categories = getDirectoryCategories();
    const optionHtml = categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)} (#${category.order})</option>`).join('');
    const selects = ['dir-field-category', 'dir-entry-category', 'dir-auth-category', 'dir-access-category', 'dir-override-category'];
    selects.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = optionHtml || '<option value="">No categories</option>';
        el.value = categories.some((category) => category.id === prev) ? prev : (categories[0]?.id || '');
    });
};
const renderDirectoryAuthConfig = () => {
    const categoryId = document.getElementById('dir-auth-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const fieldOptions = (category?.fields || []).map((field) => `<option value="${field.key}">${escapeHtml(field.label)} (${escapeHtml(field.key)})</option>`).join('');
    const usernameFieldSel = document.getElementById('dir-auth-username-field');
    const passwordFieldSel = document.getElementById('dir-auth-password-field');
    if (usernameFieldSel) usernameFieldSel.innerHTML = `<option value="">-- Select Username Field --</option>${fieldOptions}`;
    if (passwordFieldSel) passwordFieldSel.innerHTML = `<option value="">-- Select Password Field --</option>${fieldOptions}`;
    const authConfig = getCategoryAuthItem(categoryId);
    const enabledEl = document.getElementById('dir-auth-enabled');
    const modeEl = document.getElementById('dir-auth-mode');
    const targetPageEl = document.getElementById('dir-auth-target-page');
    if (enabledEl) enabledEl.checked = authConfig.enabled;
    if (modeEl) modeEl.value = authConfig.mode;
    if (targetPageEl) targetPageEl.value = authConfig.targetPage;
    if (usernameFieldSel) usernameFieldSel.value = authConfig.usernameField;
    if (passwordFieldSel) passwordFieldSel.value = authConfig.passwordField;
};
const renderDirectoryAccessConfig = () => {
    const categoryId = document.getElementById('dir-access-category')?.value || '';
    const access = getPageAccessCategoryItem(categoryId);
    const collectionEl = document.getElementById('dir-access-collection');
    const studentEl = document.getElementById('dir-access-student');
    if (collectionEl) collectionEl.checked = access.collection;
    if (studentEl) studentEl.checked = access.student;
};
const renderOverrideEntryOptions = () => {
    const categoryId = document.getElementById('dir-override-category')?.value || '';
    const select = document.getElementById('dir-override-entry');
    if (!select) return;
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const rows = publicDirectoryEntries.filter((entry) => entry.categoryId === categoryId);
    const sortedFields = [...(category?.fields || [])].sort((a, b) => a.order - b.order);
    const displayField = sortedFields[0]?.key || '';
    select.innerHTML = rows.length
        ? rows.map((entry) => `<option value="${entry.id}">${escapeHtml(String(entry.values?.[displayField] || entry.id))}</option>`).join('')
        : '<option value="">No entries</option>';
    const selectedEntryId = select.value;
    const override = pageAccessConfig?.overrides?.[selectedEntryId] || {};
    document.getElementById('dir-override-blocked').checked = override.blocked === true;
    document.getElementById('dir-override-collection').checked = override.collection === true;
    document.getElementById('dir-override-student').checked = override.student === true;
};
const renderDirectoryFields = () => {
    const categoryId = document.getElementById('dir-field-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const list = document.getElementById('dir-fields-list');
    if (!list) return;
    if (!category) {
        list.innerHTML = '<p class="text-sm text-gray-500 italic">Select a category to manage fields.</p>';
        return;
    }
    list.innerHTML = category.fields.length
        ? category.fields.map((field) => `<div class="border border-indigo-100 rounded-xl p-3 bg-white shadow-sm flex items-center justify-between gap-3">
            <div class="min-w-0">
                <div class="text-sm font-bold text-gray-800 truncate">${escapeHtml(field.label)}</div>
                <div class="text-[11px] text-gray-500 mt-0.5">${field.locked ? 'Core Field' : 'Custom Field'}</div>
            </div>
            <button class="w-8 h-8 rounded-full border border-gray-200 hover:bg-gray-100 text-gray-600 dir-field-more-btn" data-category-id="${category.id}" data-field-id="${field.id}" title="Edit field">
                <i class="fas fa-ellipsis-v"></i>
            </button>
        </div>`).join('')
        : '<p class="text-sm text-gray-500 italic">No fields added yet.</p>';
};
const renderDirectoryEntryForm = () => {
    const categoryId = document.getElementById('dir-entry-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const form = document.getElementById('dir-entry-form');
    if (!form) return;
    if (!category) {
        form.innerHTML = '<p class="text-sm text-gray-500 italic">Select a category first.</p>';
        return;
    }
    const sortedFields = [...category.fields].sort((a, b) => a.order - b.order);
    const authConfig = getCategoryAuthItem(categoryId);
    const fieldsHtml = sortedFields.map((field) => {
        const base = `data-dir-field="${field.key}"`;
        if (field.key === 'photo') {
            return `
            <div class="md:col-span-2 flex flex-col sm:flex-row gap-4 bg-gray-50 p-3 rounded-xl border border-gray-100 items-center w-full">
                <div class="relative w-16 h-16 rounded-full border-2 border-slate-200 overflow-hidden bg-slate-100 flex items-center justify-center shrink-0 shadow-inner">
                    <img id="dir-photo-preview" class="w-full h-full object-cover hidden" alt="Photo Preview">
                    <i id="dir-photo-placeholder" class="fas fa-user text-2xl text-slate-400"></i>
                </div>
                <div class="flex-1 text-center sm:text-left space-y-1.5 w-full">
                    <label class="block text-xs font-black text-slate-700">${escapeHtml(field.label)} (Max 50KB)</label>
                    <div class="flex flex-wrap gap-1.5 justify-center sm:justify-start">
                        <button type="button" id="dir-camera-btn" class="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-md font-bold text-[10px] flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-camera"></i> Camera</button>
                        <button type="button" id="dir-upload-btn" class="px-2.5 py-1 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-md font-bold text-[10px] flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-upload"></i> Upload</button>
                        <button type="button" id="dir-remove-btn" class="px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-md font-bold text-[10px] transition-all hidden">Remove</button>
                    </div>
                    <input type="hidden" ${base} id="dir-photo" value="">
                    <input type="file" id="dir-file-input" accept="image/*" class="hidden">
                </div>
            </div>`;
        }
        if (field.type === 'textarea') {
            return `<label class="text-sm font-semibold text-gray-700">${escapeHtml(field.label)} ${field.required ? '<span class="text-red-500">*</span>' : ''}<textarea ${base} class="w-full mt-1 p-2 border rounded-lg" rows="3"></textarea></label>`;
        }
        return `<label class="text-sm font-semibold text-gray-700">${escapeHtml(field.label)} ${field.required ? '<span class="text-red-500">*</span>' : ''}<input ${base} type="${escapeHtml(field.type || 'text')}" class="w-full mt-1 p-2 border rounded-lg"></label>`;
    }).join('');
    const manualAuthHtml = authConfig.enabled && authConfig.mode === 'manual'
        ? `<label class="text-sm font-semibold text-gray-700">Username <span class="text-red-500">*</span><input data-dir-manual-username type="text" class="w-full mt-1 p-2 border rounded-lg"></label>
           <label class="text-sm font-semibold text-gray-700">Password <span class="text-red-500">*</span><input data-dir-manual-password type="password" class="w-full mt-1 p-2 border rounded-lg"></label>`
        : '';
    form.innerHTML = (fieldsHtml || '<p class="text-sm text-gray-500 italic">Add fields for this category first.</p>') + manualAuthHtml;

    if (sortedFields.some(f => f.key === 'photo')) {
        setupAdminPhotoWidget('dir-photo', 'dir-photo-preview', 'dir-photo-placeholder', 'dir-remove-btn', 'dir-file-input', 'dir-camera-btn', 'dir-upload-btn');
    }
};
const renderDirectoryEntries = () => {
    const categoryId = document.getElementById('dir-entry-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const list = document.getElementById('dir-entries-list');
    if (!list) return;
    if (!category) {
        list.innerHTML = '';
        return;
    }
    const rows = publicDirectoryEntries
        .filter((entry) => entry.categoryId === categoryId)
        .sort((a, b) => {
            const orderDiff = Number(a?.displayOrder || 999) - Number(b?.displayOrder || 999);
            if (orderDiff !== 0) return orderDiff;
            return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
        });
    list.innerHTML = rows.length
        ? `<h3 class="text-sm font-bold text-cyan-800 border-b border-cyan-200 pb-2 mb-2">Active ${escapeHtml(category.name || 'Category')}</h3>` + rows.map((entry) => {
            const displayName = String(entry.values?.name || 'Profile');
            const rawPhoto = String(entry.values?.photo || entry.values?.image || '');
            const photoUrl = (rawPhoto && rawPhoto.startsWith('data:')) ? rawPhoto : sanitizeUrl(rawPhoto);
            const avatar = photoUrl
                ? `<img src="${photoUrl}" alt="${escapeHtml(displayName)}" class="w-14 h-14 rounded-full object-cover border-2 border-cyan-100">`
                : `<div class="w-14 h-14 rounded-full bg-cyan-100 text-cyan-700 font-bold flex items-center justify-center">${escapeHtml(displayName.charAt(0).toUpperCase())}</div>`;
            return `<div class="border border-cyan-200 rounded-2xl p-4 bg-white shadow-sm hover:shadow-md transition">
                <div class="flex justify-between items-center gap-3">
                    <div class="flex items-center gap-3 min-w-0">
                        ${avatar}
                        <div class="min-w-0">
                            <div class="text-base font-bold text-gray-900 truncate">${escapeHtml(displayName)}</div>
                            <div class="text-[11px] text-gray-500 mt-0.5">Entry ID: ${escapeHtml(entry.id || '--')}</div>
                        </div>
                    </div>
                    <button class="w-9 h-9 rounded-full border border-gray-200 hover:bg-gray-100 text-gray-600 dir-entry-more-btn" data-id="${entry.id}" title="Entry actions">
                        <i class="fas fa-ellipsis-v"></i>
                    </button>
                </div>
            </div>`;
        }).join('')
        : '<p class="text-sm text-gray-500 italic">No entries added for this category.</p>';
};
let currentEditingCategoryDraftFields = [];

const renderDirectoryCategories = () => {
    const categories = getAllStaffCategories();
    const list = document.getElementById('dir-categories-list');
    if (!list) return;
    list.innerHTML = categories.length
        ? categories.map((category) => {
            const isCore = CORE_STAFF_TYPES.includes(category.id);
            return `
            <div class="inline-flex items-center gap-2 bg-white border ${isCore ? 'border-blue-200 text-blue-950' : 'border-emerald-200 text-emerald-900'} px-3 py-1.5 rounded-lg text-xs font-semibold shadow-xs hover:border-emerald-300 transition">
                <span class="font-bold truncate max-w-[140px]">${escapeHtml(category.name)}</span>
                ${isCore ? '<span class="text-[9px] uppercase tracking-wider bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-bold">Default</span>' : ''}
                <span class="text-[10px] text-gray-400 font-mono">#${category.order}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded font-normal ${category.showPublic ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}">${category.showPublic ? 'Public' : 'Hidden'}</span>
                <div class="flex items-center gap-1 border-l pl-2 border-emerald-100">
                    <button type="button" class="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-50 dir-cat-edit-btn transition" data-id="${escapeHtml(category.id)}" title="Edit category & input fields">
                        <i class="fas fa-pencil-alt text-xs pointer-events-none"></i>
                    </button>
                    ${!isCore ? `
                    <button type="button" class="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 dir-cat-delete-btn transition" data-id="${escapeHtml(category.id)}" title="Delete category">
                        <i class="fas fa-trash-alt text-xs pointer-events-none"></i>
                    </button>` : ''}
                </div>
            </div>
        `}).join('')
        : '<p class="text-xs text-emerald-700 italic py-1">No categories created yet.</p>';
    renderDirectoryCategoryOptions();
    renderDirectoryFields();
    renderDirectoryEntryForm();
    renderDirectoryEntries();
    renderDirectoryAuthConfig();
    renderDirectoryAccessConfig();
    renderOverrideEntryOptions();
    renderStaffTypeControls();
    if(!document.getElementById('staff-management-page')?.classList.contains('hidden') || !document.getElementById('manage-staff-page')?.classList.contains('hidden')) renderStaffList();
};

const openEditStaffCategory = (categoryId) => {
    const categories = getAllStaffCategories();
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;
    
    document.getElementById('edit-staff-cat-id').value = category.id;
    document.getElementById('edit-staff-cat-name').value = category.name || '';
    document.getElementById('edit-staff-cat-order').value = Number(category.order || 1);
    document.getElementById('edit-staff-cat-public').checked = category.showPublic !== false;

    // Available baseline fields:
    const standardFields = DEFAULT_STAFF_CATEGORY_FIELDS.map((f) => ({ ...f }));

    const activeKeys = new Set((category.fields || []).map((f) => f.key));
    
    const allFields = standardFields.map((std) => {
        const existing = (category.fields || []).find((f) => f.key === std.key);
        return {
            ...std,
            label: existing?.label || std.label,
            required: std.key === 'name' ? true : Boolean(existing ? existing.required : std.required),
            active: std.key === 'name' ? true : activeKeys.has(std.key)
        };
    });

    // Also include any custom fields that already exist on category
    (category.fields || []).forEach((f) => {
        if (!standardFields.some((std) => std.key === f.key)) {
            allFields.push({
                ...f,
                active: true,
                locked: false
            });
        }
    });

    currentEditingCategoryDraftFields = allFields;
    renderEditStaffCategoryFieldsList();

    const popup = document.getElementById('edit-staff-category-popup');
    if (popup) {
        popup.classList.remove('hidden');
        popup.classList.add('flex');
    }
};

const renderEditStaffCategoryFieldsList = () => {
    const container = document.getElementById('edit-staff-cat-fields-list');
    if (!container) return;
    const standardKeys = new Set(DEFAULT_STAFF_CATEGORY_FIELDS.map((f) => f.key));
    container.innerHTML = currentEditingCategoryDraftFields.map((field, idx) => `
        <div class="flex items-center justify-between p-2 rounded-lg bg-white border border-gray-200 gap-2">
            <label class="inline-flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                <input type="checkbox" class="w-4 h-4 text-emerald-600 rounded edit-field-toggle-cb" data-idx="${idx}" ${field.active ? 'checked' : ''} ${field.locked ? 'disabled' : ''}>
                <div class="min-w-0">
                    <span class="text-xs font-bold ${field.active ? 'text-gray-800' : 'line-through text-gray-400'}">${escapeHtml(field.label)}</span>
                    <span class="text-[10px] text-gray-400 ml-1">(${escapeHtml(field.type || 'text')})</span>
                </div>
            </label>
            <div class="flex items-center gap-2 shrink-0">
                ${field.key !== 'name' ? `
                    <label class="inline-flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer ${field.active ? '' : 'opacity-40'}">
                        <input type="checkbox" class="w-3.5 h-3.5 text-blue-600 rounded edit-field-req-cb" data-idx="${idx}" ${field.required ? 'checked' : ''} ${field.active ? '' : 'disabled'}>
                        <span>Required</span>
                    </label>
                ` : '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">Core ID</span>'}
                ${!standardKeys.has(field.key) ? `
                    <button type="button" class="text-red-500 hover:text-red-700 p-1 edit-field-del-custom-btn" data-idx="${idx}" title="Remove custom field">
                        <i class="fas fa-trash-alt text-xs pointer-events-none"></i>
                    </button>
                ` : ''}
            </div>
        </div>
    `).join('');
};

const closeEditStaffCategoryModal = () => {
    const popup = document.getElementById('edit-staff-category-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }
};

const updateDirectoryCategories = async (categories = []) => {
    const normalized = categories.map(normalizeDirectoryCategory);
    webContent.directoryCategories = normalized;
    // Fast targeted update to Firestore instead of writing all notices & gallery
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'content'), { directoryCategories: normalized }, { merge: true });
    renderDirectoryCategories();
};

document.getElementById('dir-cat-add-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage') && !requirePermission('staff.manage')) return;
    const addBtn = document.getElementById('dir-cat-add-btn');
    const name = document.getElementById('dir-cat-name')?.value?.trim() || '';
    const order = Number(document.getElementById('dir-cat-order')?.value || 1);
    const showPublic = document.getElementById('dir-cat-public')?.checked !== false;
    if (!name) return alert('Enter a category name.');
    const origHtml = addBtn ? addBtn.innerHTML : 'Add';
    if (addBtn) {
        addBtn.disabled = true;
        addBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Adding...';
    }
    try {
        const categories = getAllStaffCategories();
        categories.push(normalizeDirectoryCategory({
            name,
            order,
            showPublic,
            fields: DEFAULT_STAFF_CATEGORY_FIELDS.map((f) => ({ ...f }))
        }));
        await updateDirectoryCategories(categories);
        document.getElementById('dir-cat-name').value = '';
    } catch (err) {
        console.error('Failed to add category:', err);
        alert(`Failed to add category: ${err?.message || 'Error occurred.'}`);
    } finally {
        if (addBtn) {
            addBtn.disabled = false;
            addBtn.innerHTML = origHtml;
        }
    }
});

document.getElementById('dir-categories-list')?.addEventListener('click', async (event) => {
    const editBtn = event.target.closest('.dir-cat-edit-btn');
    const deleteBtn = event.target.closest('.dir-cat-delete-btn');
    if (editBtn) {
        openEditStaffCategory(editBtn.dataset.id);
        return;
    }
    if (deleteBtn) {
        const targetId = deleteBtn.dataset.id;
        if (CORE_STAFF_TYPES.includes(targetId)) {
            return alert('Default categories (Teacher & Management) cannot be deleted. You can edit their fields instead.');
        }
        if (!confirm('Delete this category and its entries?')) return;
        const categories = getAllStaffCategories();
        const next = categories.filter((item) => item.id !== targetId);
        await updateDirectoryCategories(next);
        const deleteTargets = publicDirectoryEntries.filter((entry) => entry.categoryId === targetId);
        const reassignedStaff = allStaff.filter((staffMember) => staffMember.type === targetId);
        await Promise.all([
            ...deleteTargets.map((entry) => deleteDoc(doc(db, `${BASE_PATH}/publicDirectory`, entry.id))),
            ...reassignedStaff.map((staffMember) => updateDoc(doc(db, `${BASE_PATH}/staff`, staffMember.id), { type: 'Management' }))
        ]);
    }
});

// Category Modal Event Handlers
document.getElementById('edit-staff-cat-close-btn')?.addEventListener('click', closeEditStaffCategoryModal);
document.getElementById('edit-staff-cat-cancel-btn')?.addEventListener('click', closeEditStaffCategoryModal);

document.getElementById('edit-staff-cat-fields-list')?.addEventListener('change', (event) => {
    const toggleCb = event.target.closest('.edit-field-toggle-cb');
    const reqCb = event.target.closest('.edit-field-req-cb');
    if (toggleCb) {
        const idx = Number(toggleCb.dataset.idx);
        if (currentEditingCategoryDraftFields[idx]) {
            currentEditingCategoryDraftFields[idx].active = toggleCb.checked;
            renderEditStaffCategoryFieldsList();
        }
    }
    if (reqCb) {
        const idx = Number(reqCb.dataset.idx);
        if (currentEditingCategoryDraftFields[idx]) {
            currentEditingCategoryDraftFields[idx].required = reqCb.checked;
        }
    }
});

document.getElementById('edit-staff-cat-fields-list')?.addEventListener('click', (event) => {
    const delBtn = event.target.closest('.edit-field-del-custom-btn');
    if (delBtn) {
        const idx = Number(delBtn.dataset.idx);
        if (!confirm('Remove this custom field?')) return;
        currentEditingCategoryDraftFields.splice(idx, 1);
        renderEditStaffCategoryFieldsList();
    }
});

document.getElementById('edit-staff-cat-add-field-btn')?.addEventListener('click', () => {
    const label = document.getElementById('edit-staff-cat-new-field-label')?.value?.trim();
    const type = document.getElementById('edit-staff-cat-new-field-type')?.value || 'text';
    if (!label) return alert('Enter a field label.');
    const key = `custom_${label.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)}_${Date.now().toString(36).slice(-3)}`;
    currentEditingCategoryDraftFields.push({
        id: `field_${Date.now()}`,
        key,
        label,
        type,
        required: false,
        active: true,
        locked: false,
        order: currentEditingCategoryDraftFields.length + 1
    });
    document.getElementById('edit-staff-cat-new-field-label').value = '';
    renderEditStaffCategoryFieldsList();
});

document.getElementById('edit-staff-cat-save-btn')?.addEventListener('click', async () => {
    if (!requirePermission('website.manage') && !requirePermission('staff.manage')) return;
    const saveBtn = document.getElementById('edit-staff-cat-save-btn');
    const categoryId = document.getElementById('edit-staff-cat-id')?.value;
    const name = document.getElementById('edit-staff-cat-name')?.value?.trim();
    const order = Number(document.getElementById('edit-staff-cat-order')?.value || 1);
    const showPublic = document.getElementById('edit-staff-cat-public')?.checked !== false;
    if (!name) return alert('Category name is required.');

    const origBtnHtml = saveBtn ? saveBtn.innerHTML : 'Save Changes';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Saving...';
    }

    try {
        const activeFields = currentEditingCategoryDraftFields
            .filter((f) => f.active)
            .map((f, i) => normalizeDirectoryField({
                id: f.id || `field_${f.key}`,
                key: f.key,
                label: f.label,
                type: f.type,
                required: f.key === 'name' ? true : Boolean(f.required),
                order: i + 1,
                locked: f.key === 'name'
            }));

        const categories = getAllStaffCategories();
        const next = categories.map((c) => c.id === categoryId ? {
            ...c,
            id: categoryId,
            name,
            order,
            showPublic,
            fields: activeFields
        } : c);

        await updateDirectoryCategories(next);
        closeEditStaffCategoryModal();
        if (typeof showToast === 'function') {
            showToast('Category updated successfully!', 'success');
        }
    } catch (err) {
        console.error('Failed to save category:', err);
        alert(`Failed to save: ${err?.message || 'Error occurred.'}`);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = origBtnHtml;
        }
    }
});
document.getElementById('dir-field-category')?.addEventListener('change', () => { renderDirectoryFields(); });
document.getElementById('dir-entry-category')?.addEventListener('change', () => { renderDirectoryEntryForm(); renderDirectoryEntries(); });
document.getElementById('dir-field-add-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const categoryId = document.getElementById('dir-field-category')?.value || '';
    const label = document.getElementById('dir-field-label')?.value?.trim() || '';
    const type = document.getElementById('dir-field-type')?.value || 'text';
    const order = Number(document.getElementById('dir-field-order')?.value || 1);
    const required = document.getElementById('dir-field-required')?.checked === true;
    if (!categoryId || !label) return alert('Select category and enter field label.');
    const categories = getDirectoryCategories();
    const targetCategory = categories.find((item) => item.id === categoryId);
    if (!targetCategory) return alert('Category not found.');
    const draftField = normalizeDirectoryField({ label, type, order, required });
    if (targetCategory.fields.some((field) => field.key === draftField.key)) {
        return alert('Field key already exists in this category.');
    }
    const next = categories.map((category) => category.id === categoryId
        ? { ...category, fields: ensureDefaultDirectoryFields([...category.fields, draftField]) }
        : category);
    await updateDirectoryCategories(next);
    document.getElementById('dir-field-label').value = '';
});
document.getElementById('dir-fields-list')?.addEventListener('click', (event) => {
    const moreBtn = event.target.closest('.dir-field-more-btn');
    if (!moreBtn) return;
    const categories = getDirectoryCategories();
    const category = categories.find((item) => item.id === moreBtn.dataset.categoryId);
    const field = category?.fields.find((item) => item.id === moreBtn.dataset.fieldId);
    if (!category || !field) return;
    document.getElementById('dir-field-edit-category-id').value = category.id;
    document.getElementById('dir-field-edit-field-id').value = field.id;
    document.getElementById('dir-field-edit-label').value = field.label || '';
    document.getElementById('dir-field-edit-key').value = field.key || '';
    document.getElementById('dir-field-edit-type').value = field.type || 'text';
    document.getElementById('dir-field-edit-order').value = Number(field.order || 1);
    document.getElementById('dir-field-edit-required').checked = field.required === true;
    document.getElementById('dir-field-edit-key').readOnly = field.locked === true;
    document.getElementById('dir-field-edit-required').disabled = field.key === 'name';
    document.getElementById('dir-field-edit-delete').disabled = field.locked === true;
    document.getElementById('dir-field-edit-popup')?.classList.remove('hidden');
    document.getElementById('dir-field-edit-popup')?.classList.add('flex');
});
document.getElementById('dir-field-edit-cancel')?.addEventListener('click', () => {
    document.getElementById('dir-field-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-field-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-field-edit-save')?.addEventListener('click', async () => {
    const categoryId = document.getElementById('dir-field-edit-category-id')?.value || '';
    const fieldId = document.getElementById('dir-field-edit-field-id')?.value || '';
    const categories = getDirectoryCategories();
    const category = categories.find((item) => item.id === categoryId);
    const field = category?.fields.find((item) => item.id === fieldId);
    if (!category || !field) return;
    const label = String(document.getElementById('dir-field-edit-label')?.value || '').trim();
    const key = String(document.getElementById('dir-field-edit-key')?.value || '').trim().toLowerCase();
    const type = String(document.getElementById('dir-field-edit-type')?.value || 'text').trim();
    const order = Number(document.getElementById('dir-field-edit-order')?.value || field.order || 1);
    const required = document.getElementById('dir-field-edit-required')?.checked === true;
    if (!label) return alert('Field label is required.');
    if (!key) return alert('Field key is required.');
    if (field.locked && key !== field.key) return alert('Core field key cannot be changed.');
    if (category.fields.some((item) => item.id !== field.id && item.key === key)) return alert('Field key must be unique.');
    const next = categories.map((item) => item.id === category.id ? {
        ...item,
        fields: ensureDefaultDirectoryFields(item.fields.map((row) => row.id === field.id
            ? normalizeDirectoryField({ ...row, label, key, type, order, required: row.key === 'name' ? true : required, locked: row.locked === true })
            : row))
    } : item);
    await updateDirectoryCategories(next);
    document.getElementById('dir-field-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-field-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-field-edit-delete')?.addEventListener('click', async () => {
    const categoryId = document.getElementById('dir-field-edit-category-id')?.value || '';
    const fieldId = document.getElementById('dir-field-edit-field-id')?.value || '';
    const categories = getDirectoryCategories();
    const category = categories.find((item) => item.id === categoryId);
    const field = category?.fields.find((item) => item.id === fieldId);
    if (!category || !field) return;
    if (field.locked) return alert('Core fields cannot be deleted.');
    if (!confirm('Delete this field from category?')) return;
    const next = categories.map((item) => item.id === category.id ? { ...item, fields: item.fields.filter((row) => row.id !== fieldId) } : item);
    await updateDirectoryCategories(next);
    document.getElementById('dir-field-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-field-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-entry-save-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const categoryId = document.getElementById('dir-entry-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    if (!category) return alert('Select category.');
    const authConfig = getCategoryAuthItem(categoryId);
    const values = {};
    let missingRequired = false;
    category.fields.forEach((field) => {
        const input = document.querySelector(`[data-dir-field="${field.key}"]`);
        const value = String(input?.value || '').trim();
        values[field.key] = value;
        if (field.required && !value) missingRequired = true;
    });
    if (missingRequired) return alert('Please fill all required fields.');
    let authMeta = {};
    if (authConfig.enabled) {
        if (authConfig.mode === 'manual') {
            const username = String(document.querySelector('[data-dir-manual-username]')?.value || '').trim();
            const password = String(document.querySelector('[data-dir-manual-password]')?.value || '').trim();
            if (!username || !password) return alert('Manual mode requires username and password.');
            authMeta = {
                username: username.toLowerCase(),
                usernameRaw: username,
                passwordHash: await hashCredentialValue(password)
            };
        } else {
            const username = String(values?.[authConfig.usernameField] || '').trim();
            const password = String(values?.[authConfig.passwordField] || '').trim();
            if (!username || !password) return alert('Mapped mode requires valid username/password field values.');
            authMeta = {
                username: username.toLowerCase(),
                usernameRaw: username,
                passwordHash: await hashCredentialValue(password)
            };
        }
    }
    await addDoc(collection(db, `${BASE_PATH}/publicDirectory`), {
        categoryId,
        values,
        displayOrder: Math.max(1, Number(document.getElementById('dir-entry-order')?.value || 999)),
        authMeta,
        createdAt: Date.now(),
        updatedAt: Date.now()
    });
    document.getElementById('dir-entry-order').value = '999';
    renderDirectoryEntryForm();
});
document.getElementById('dir-entries-list')?.addEventListener('click', (event) => {
    const moreBtn = event.target.closest('.dir-entry-more-btn');
    if (!moreBtn) return;
    const categoryId = document.getElementById('dir-entry-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    const entry = publicDirectoryEntries.find((item) => item.id === moreBtn.dataset.id);
    if (!category || !entry) return;
    document.getElementById('dir-entry-edit-id').value = entry.id;
    document.getElementById('dir-entry-edit-order').value = Math.max(1, Number(entry.displayOrder || 999));
    const host = document.getElementById('dir-entry-edit-form');
    host.innerHTML = category.fields.map((field) => {
        const value = String(entry.values?.[field.key] ?? '');
        if (field.key === 'photo') {
            return `
            <div class="md:col-span-2 flex flex-col sm:flex-row gap-4 bg-gray-50 p-3 rounded-xl border border-gray-100 items-center w-full">
                <div class="relative w-16 h-16 rounded-full border-2 border-slate-200 overflow-hidden bg-slate-100 flex items-center justify-center shrink-0 shadow-inner">
                    <img id="e-dir-photo-preview" class="w-full h-full object-cover ${value ? '' : 'hidden'}" src="${value || ''}" alt="Photo Preview">
                    <i id="e-dir-photo-placeholder" class="fas fa-user text-2xl text-slate-400 ${value ? 'hidden' : ''}"></i>
                </div>
                <div class="flex-1 text-center sm:text-left space-y-1.5 w-full">
                    <label class="block text-xs font-black text-slate-700">${escapeHtml(field.label)} (Max 50KB)</label>
                    <div class="flex flex-wrap gap-1.5 justify-center sm:justify-start">
                        <button type="button" id="e-dir-camera-btn" class="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-md font-bold text-[10px] flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-camera"></i> Camera</button>
                        <button type="button" id="e-dir-upload-btn" class="px-2.5 py-1 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-md font-bold text-[10px] flex items-center gap-1 shadow-sm transition-all"><i class="fas fa-upload"></i> Upload</button>
                        <button type="button" id="e-dir-remove-btn" class="px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-md font-bold text-[10px] transition-all ${value ? '' : 'hidden'}">Remove</button>
                    </div>
                    <input type="hidden" class="dir-entry-popup-field" data-key="photo" data-type="text" id="e-dir-photo" value="${escapeHtml(value)}">
                    <input type="file" id="e-dir-file-input" accept="image/*" class="hidden">
                </div>
            </div>`;
        }
        if (field.type === 'textarea') {
            return `<label class="text-sm font-semibold text-gray-700 md:col-span-2">${escapeHtml(field.label)} ${field.required ? '<span class="text-red-500">*</span>' : ''}<textarea class="w-full mt-1 p-2 border rounded-lg dir-entry-popup-field" rows="3" data-key="${field.key}" data-type="${field.type}">${escapeHtml(value)}</textarea></label>`;
        }
        return `<label class="text-sm font-semibold text-gray-700">${escapeHtml(field.label)} ${field.required ? '<span class="text-red-500">*</span>' : ''}<input type="${escapeHtml(field.type || 'text')}" class="w-full mt-1 p-2 border rounded-lg dir-entry-popup-field" data-key="${field.key}" data-type="${field.type}" value="${escapeHtml(value)}"></label>`;
    }).join('');

    if (category.fields.some(f => f.key === 'photo')) {
        setupAdminPhotoWidget('e-dir-photo', 'e-dir-photo-preview', 'e-dir-photo-placeholder', 'e-dir-remove-btn', 'e-dir-file-input', 'e-dir-camera-btn', 'e-dir-upload-btn');
    }
    document.getElementById('dir-entry-edit-popup')?.classList.remove('hidden');
    document.getElementById('dir-entry-edit-popup')?.classList.add('flex');
});
document.getElementById('dir-entry-edit-cancel')?.addEventListener('click', () => {
    document.getElementById('dir-entry-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-entry-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-entry-edit-save')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const entryId = document.getElementById('dir-entry-edit-id')?.value || '';
    const categoryId = document.getElementById('dir-entry-category')?.value || '';
    const category = getDirectoryCategories().find((item) => item.id === categoryId);
    if (!entryId || !category) return;
    const authConfig = getCategoryAuthItem(categoryId);
    const values = {};
    let missingRequired = false;
    category.fields.forEach((field) => {
        const input = document.querySelector(`.dir-entry-popup-field[data-key="${field.key}"]`);
        const value = String(input?.value || '').trim();
        values[field.key] = value;
        if (field.required && !value) missingRequired = true;
    });
    if (missingRequired) return alert('Please fill all required fields.');
    const targetEntry = publicDirectoryEntries.find((entry) => entry.id === entryId) || {};
    let authMeta = targetEntry.authMeta && typeof targetEntry.authMeta === 'object' ? targetEntry.authMeta : {};
    if (authConfig.enabled && authConfig.mode === 'mapped') {
        const username = String(values?.[authConfig.usernameField] || '').trim();
        const password = String(values?.[authConfig.passwordField] || '').trim();
        if (!username || !password) return alert('Mapped mode requires valid username/password field values.');
        authMeta = { username: username.toLowerCase(), usernameRaw: username, passwordHash: await hashCredentialValue(password) };
    }
    await updateDoc(doc(db, `${BASE_PATH}/publicDirectory`, entryId), {
        values,
        displayOrder: Math.max(1, Number(document.getElementById('dir-entry-edit-order')?.value || 999)),
        authMeta,
        updatedAt: Date.now()
    });
    document.getElementById('dir-entry-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-entry-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-entry-edit-delete')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const entryId = document.getElementById('dir-entry-edit-id')?.value || '';
    if (!entryId) return;
    if (!confirm('Delete this entry?')) return;
    await deleteDoc(doc(db, `${BASE_PATH}/publicDirectory`, entryId));
    document.getElementById('dir-entry-edit-popup')?.classList.add('hidden');
    document.getElementById('dir-entry-edit-popup')?.classList.remove('flex');
});
document.getElementById('dir-auth-category')?.addEventListener('change', renderDirectoryAuthConfig);
document.getElementById('dir-access-category')?.addEventListener('change', renderDirectoryAccessConfig);
document.getElementById('dir-override-category')?.addEventListener('change', renderOverrideEntryOptions);
document.getElementById('dir-override-entry')?.addEventListener('change', renderOverrideEntryOptions);
document.getElementById('dir-auth-save-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const categoryId = document.getElementById('dir-auth-category')?.value || '';
    if (!categoryId) return alert('Select category.');
    const enabled = document.getElementById('dir-auth-enabled').checked;
    const mode = document.getElementById('dir-auth-mode').value === 'mapped' ? 'mapped' : 'manual';
    const targetPage = document.getElementById('dir-auth-target-page').value === 'student' ? 'student' : 'collection';
    const usernameField = document.getElementById('dir-auth-username-field').value;
    const passwordField = document.getElementById('dir-auth-password-field').value;
    if (enabled && mode === 'mapped' && (!usernameField || !passwordField)) {
        return alert('Mapped mode requires username/password field selection.');
    }
    const next = {
        ...categoryAuthConfig,
        categories: {
            ...(categoryAuthConfig.categories || {}),
            [categoryId]: { enabled, mode, targetPage, usernameField, passwordField }
        }
    };
    await updateCategoryAuthConfig(next);
    await logAuditEvent({ category: 'security', action: 'category.auth.save', entityType: 'categoryAuth', entityId: categoryId, message: 'Category login setup updated.' });
    alert('Category login setup saved.');
});
document.getElementById('dir-access-save-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const categoryId = document.getElementById('dir-access-category')?.value || '';
    if (!categoryId) return alert('Select category.');
    const collection = document.getElementById('dir-access-collection').checked;
    const student = document.getElementById('dir-access-student').checked;
    const next = {
        ...pageAccessConfig,
        categories: {
            ...(pageAccessConfig.categories || {}),
            [categoryId]: { collection, student }
        }
    };
    await updatePageAccessConfig(next);
    await logAuditEvent({ category: 'security', action: 'page.access.category.save', entityType: 'pageAccess', entityId: categoryId, message: 'Category default page access updated.' });
    alert('Category page access saved.');
});
document.getElementById('dir-override-save-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const entryId = document.getElementById('dir-override-entry')?.value || '';
    if (!entryId) return alert('Select an entry.');
    const blocked = document.getElementById('dir-override-blocked').checked;
    const collection = document.getElementById('dir-override-collection').checked;
    const student = document.getElementById('dir-override-student').checked;
    const next = {
        ...pageAccessConfig,
        overrides: {
            ...(pageAccessConfig.overrides || {}),
            [entryId]: { blocked, collection, student }
        }
    };
    await updatePageAccessConfig(next);
    await logAuditEvent({ category: 'security', action: 'page.access.override.save', entityType: 'pageAccessOverride', entityId: entryId, message: 'Entry level page access override saved.' });
    alert('Override saved.');
});
document.getElementById('dir-override-clear-btn')?.addEventListener('click', async () => {
    if(!requirePermission('website.manage')) return;
    const entryId = document.getElementById('dir-override-entry')?.value || '';
    if (!entryId) return alert('Select an entry.');
    const nextOverrides = { ...(pageAccessConfig.overrides || {}) };
    delete nextOverrides[entryId];
    await updatePageAccessConfig({ ...pageAccessConfig, overrides: nextOverrides });
    renderOverrideEntryOptions();
    await logAuditEvent({ category: 'security', action: 'page.access.override.clear', entityType: 'pageAccessOverride', entityId: entryId, message: 'Entry level page access override cleared.' });
    alert('Override cleared.');
});

// --- 11. SECURITY SETTINGS ---
document.getElementById('save-admin-auth-btn')?.addEventListener('click', async () => {
    if(!requirePermission('security.manage')) return;
    const currentAccount = getCurrentAdminAccount();
    if (!currentAccount?.email) return alert('Current admin account is not available.');
    if(!confirm('Sync the current signed-in account as the primary legacy admin email?')) return;
    const nextAdmins = normalizeAdminAccounts(adminAccounts, currentAccount.email);
    await setDoc(getAdminAuthRef(), buildAdminAuthPayload(currentAccount.email, nextAdmins), {merge: true});
    await logAuditEvent({ category: 'security', action: 'admin.legacy.sync', entityType: 'settings', entityId: 'adminAuth', message: `Legacy admin email synced to ${currentAccount.email}.` });
    alert('Legacy admin email synced successfully.');
});
document.getElementById('update-admin-credentials-btn')?.addEventListener('click', async () => {
    if(!requirePermission('security.manage')) return;
    const currentPassword = document.getElementById('admin-cred-current-password')?.value?.trim() || '';
    const requestedEmail = document.getElementById('admin-cred-new-email')?.value?.trim() || '';
    const requestedPassword = document.getElementById('admin-cred-new-password')?.value || '';
    if (!currentPassword) return alert('Current password is required.');
    if (!requestedEmail && !requestedPassword) return alert('Enter a new email or a new password.');
    if (requestedPassword && requestedPassword.length < 6) return alert('New password must be at least 6 characters.');
    const authUser = auth.currentUser;
    if (!authUser?.email) return alert('Authenticated admin account not found. Please log in again.');

    const oldEmail = normalizeEmail(authUser.email);
    const nextEmail = normalizeEmail(requestedEmail || oldEmail);
    const changedEmail = nextEmail !== oldEmail;
    const changedPassword = Boolean(requestedPassword);
    if(!confirm(`Update current admin login credentials?\n${changedEmail ? `Email: ${oldEmail} -> ${nextEmail}` : 'Email: No change'}\n${changedPassword ? 'Password: Will be updated' : 'Password: No change'}`)) return;

    try {
        const credential = EmailAuthProvider.credential(authUser.email, currentPassword);
        await reauthenticateWithCredential(authUser, credential);
        if (changedEmail) await updateEmail(authUser, nextEmail);
        if (changedPassword) await updatePassword(authUser, requestedPassword);

        if (changedEmail) {
            const adminRef = getAdminAuthRef();
            const adminSnap = await getDoc(adminRef);
            const adminData = adminSnap.exists() ? adminSnap.data() : {};
            const legacyEmail = normalizeEmail(adminData.email || oldEmail);
            const sourceAdmins = SINGLE_ADMIN_MODE
                ? normalizeAdminAccounts([], legacyEmail)
                : normalizeAdminAccounts(adminData.admins || [], legacyEmail);
            let hasUpdatedCurrent = false;
            const nextAdmins = sourceAdmins.map((account) => {
                if (normalizeEmail(account.email) !== oldEmail) return account;
                hasUpdatedCurrent = true;
                return { ...account, email: nextEmail, updatedAt: new Date().toISOString(), isActive: true };
            });
            if (!hasUpdatedCurrent) {
                nextAdmins.push({
                    name: authUser.displayName || 'Admin',
                    email: nextEmail,
                    role: currentAdminRole || 'super_admin',
                    isActive: true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }
            const nextLegacyEmail = legacyEmail === oldEmail ? nextEmail : legacyEmail;
            await setDoc(adminRef, buildAdminAuthPayload(nextLegacyEmail, nextAdmins), { merge: true });
            currentAdminEmail = nextEmail;
        }

        await logAuditEvent({
            category: 'security',
            action: 'admin.credentials.update',
            entityType: 'admin',
            entityId: currentAdminEmail || oldEmail,
            message: `Current admin login updated (${changedEmail ? 'email' : ''}${changedEmail && changedPassword ? ' + ' : ''}${changedPassword ? 'password' : ''}).`
        });
        ['admin-cred-current-password', 'admin-cred-new-email', 'admin-cred-new-password'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        renderSessionMonitor();
        alert('Admin login credentials updated successfully.');
    } catch (error) {
        console.error('Failed to update admin login credentials.', error);
        alert(`Credential update failed: ${error?.message || 'Please verify current password and try again.'}`);
    }
});
document.getElementById('add-admin-role-btn')?.addEventListener('click', async () => {
    if(!requirePermission('security.manage')) return;
    alert('Only one Super Admin is allowed. Use "Update Current Admin Login" to change email/password.');
});
document.getElementById('admin-role-list')?.addEventListener('click', async (e) => {
    if(!requirePermission('security.manage')) return;
    const trigger = e.target.closest('.admin-role-toggle-btn, .admin-role-delete-btn');
    if (!trigger) return;
    alert('Only one Super Admin is allowed in this setup.');
});
document.getElementById('refresh-session-monitor-btn').addEventListener('click', renderSessionMonitor);
document.getElementById('security-settings-page')?.addEventListener('click', async (event) => {
    const moreBtn = event.target.closest('.session-action-more-btn');
    if (moreBtn) {
        const deviceId = moreBtn.dataset.deviceId || '';
        document.querySelectorAll('.session-action-menu').forEach((menu) => {
            if (menu.dataset.deviceId !== deviceId) menu.classList.add('hidden');
        });
        const menu = document.querySelector(`.session-action-menu[data-device-id="${deviceId}"]`);
        if (menu) menu.classList.toggle('hidden');
        return;
    }
    const actionBtn = event.target.closest('.session-action-btn');
    if (!actionBtn) return;
    if(!requirePermission('security.manage')) return;
    const deviceId = actionBtn.dataset.deviceId || '';
    const action = actionBtn.dataset.action || '';
    if (!deviceId || !action) return;
    if (action === 'force-logout') {
        await updateSessionRegistryEntry(deviceId, { forcedLogoutAt: new Date().toISOString(), forceLogout: true });
    }
    if (action === 'block') {
        await updateSessionRegistryEntry(deviceId, { isBlocked: true, forceLogout: true, forcedLogoutAt: new Date().toISOString() });
    }
    if (action === 'unblock') {
        await updateSessionRegistryEntry(deviceId, { isBlocked: false });
    }
    renderSessionMonitor();
});
document.getElementById('logout-current-admin-btn').addEventListener('click', () => window.logoutAdmin());
document.getElementById('force-logout-btn').addEventListener('click', async () => {
    if(!requirePermission('security.manage')) return;
    if(!confirm('Force all staff/admin sessions to sign in again? This will also affect your current session.')) return;
    const payload = { lastForcedLogoutAt: new Date().toISOString(), forcedBy: currentAdminEmail, message: 'A security action ended your session. Please sign in again.' };
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'sessionControl'), payload, { merge: true });
    await logAuditEvent({ category: 'security', action: 'session.force_logout', entityType: 'settings', entityId: 'sessionControl', message: 'Global force logout triggered for staff/admin sessions.' });
});
document.getElementById('backup-export-btn').addEventListener('click', async () => {
    if(!requirePermission('backup.export')) return;
    const payload = await buildBackupPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fee-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    await logAuditEvent({ category: 'backup', action: 'backup.export', entityType: 'backup', message: 'JSON backup exported from admin panel.' });
});
document.getElementById('restore-file-input').addEventListener('change', async (e) => {
    if(!requirePermission('backup.restore')) return;
    const file = e.target.files?.[0];
    const runRestoreBtn = document.getElementById('run-restore-btn');
    if (!file) return;
    const textPayload = await file.text();
    try {
        const parsedPayload = JSON.parse(textPayload);
        const validation = validateBackupPayload(parsedPayload);
        if (!validation.valid) {
            pendingRestorePayload = null;
            document.getElementById('restore-preview').classList.add('hidden');
            if (runRestoreBtn) runRestoreBtn.disabled = true;
            return alert(`Invalid backup file: ${validation.reason}`);
        }

        pendingRestorePayload = parsedPayload;
        document.getElementById('restore-preview').classList.remove('hidden');
        document.getElementById('restore-preview-meta').textContent = `Backup date: ${formatDateTime(pendingRestorePayload.exportedAt)} • Source: ${pendingRestorePayload.institution || BASE_PATH}`;
        document.getElementById('restore-preview-counts').textContent = summarizeBackupCounts(pendingRestorePayload);
        if (runRestoreBtn) runRestoreBtn.disabled = false;
    } catch (error) {
        console.error(error);
        pendingRestorePayload = null;
        document.getElementById('restore-preview').classList.add('hidden');
        if (runRestoreBtn) runRestoreBtn.disabled = true;
        alert('Invalid backup file. Please choose a valid JSON export.');
    }
});
const runRestoreBtn = document.getElementById('run-restore-btn');
if (runRestoreBtn) runRestoreBtn.disabled = true;

document.getElementById('run-restore-btn').addEventListener('click', async () => {
    if(!requirePermission('backup.restore')) return;
    if (!pendingRestorePayload) return alert('Select a backup file first.');
    const validation = validateBackupPayload(pendingRestorePayload);
    if (!validation.valid) return alert(`Selected backup is invalid: ${validation.reason}`);
    if(!confirm('This will replace current data with the selected backup snapshot. Continue?')) return;
    await restoreFromBackupPayload(pendingRestorePayload);
    await logAuditEvent({ category: 'backup', action: 'backup.restore', entityType: 'backup', message: 'Backup restore completed from selected JSON payload.', metadata: { exportedAt: pendingRestorePayload.exportedAt || '' } });
    pendingRestorePayload = null;
    document.getElementById('restore-preview').classList.add('hidden');
    document.getElementById('restore-file-input').value = '';
    const runRestoreBtn = document.getElementById('run-restore-btn');
    if (runRestoreBtn) runRestoreBtn.disabled = true;
    alert('Backup restore completed.');
});
document.getElementById('audit-filter-action')?.addEventListener('change', renderAuditLogList);
document.getElementById('audit-search-input')?.addEventListener('input', renderAuditLogList);
document.getElementById('audit-log-list')?.addEventListener('click', (event) => {
    const targetBtn = event.target.closest('.audit-open-target-btn');
    if (!targetBtn) return;
    const target = targetBtn.dataset.target;
    if (!target) return;
    activateAdminPage(target, { suppressDeniedAlert: false });
});

const handleClearAuditLogs = async () => {
    if (!requirePermission('security.manage')) return;
    if (!auditLogs.length) {
        return alert("There are no audit logs to clear.");
    }

    const currentCount = auditLogs.length;
    if (!confirm(`Are you sure you want to clear all ${currentCount} audit logs?\n\nThis will purge all previous audit records and record a single fresh checkpoint with a summary of the cleared events.`)) {
        return;
    }

    const clearBtn = document.getElementById('clear-audit-logs-btn');
    try {
        if (clearBtn) {
            clearBtn.disabled = true;
            clearBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-[10px]"></i> <span>Clearing...</span>';
        }

        // 1. Calculate summary breakdown
        const categoryCounts = {};
        let oldestTs = null;
        let newestTs = null;

        auditLogs.forEach((log) => {
            const cat = log.category || 'general';
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            const ts = log.timestamp || (log.createdAt ? new Date(log.createdAt).getTime() : null);
            if (ts) {
                if (!oldestTs || ts < oldestTs) oldestTs = ts;
                if (!newestTs || ts > newestTs) newestTs = ts;
            }
        });

        // 2. Fetch all existing auditLog document refs
        const snap = await getDocs(collection(db, `${BASE_PATH}/auditLogs`));
        const allDocRefs = snap.docs.map(d => d.ref);

        // 3. Delete in batches of 400 (Firestore limit is 500)
        const batchSize = 400;
        for (let i = 0; i < allDocRefs.length; i += batchSize) {
            const batch = writeBatch(db);
            const chunk = allDocRefs.slice(i, i + batchSize);
            chunk.forEach(ref => batch.delete(ref));
            await batch.commit();
        }

        // 4. Create the single new checkpoint log document
        const checkpointData = {
            category: 'security',
            action: 'audit.cleared',
            adminEmail: currentAdminEmail || 'super_admin',
            adminRole: currentAdminRole || 'super_admin',
            createdAt: new Date().toISOString(),
            timestamp: Date.now(),
            isClearCheckpoint: true,
            message: `Audit logs cleared by Super Admin (${currentCount} previous entries purged).`,
            summary: {
                totalPurged: currentCount,
                categories: categoryCounts,
                period: {
                    from: oldestTs ? new Date(oldestTs).toISOString() : '',
                    to: newestTs ? new Date(newestTs).toISOString() : ''
                }
            }
        };

        const newDocRef = await addDoc(collection(db, `${BASE_PATH}/auditLogs`), checkpointData);

        // Update local memory so UI immediately updates
        auditLogs = [{ id: newDocRef.id, ...checkpointData }];
        renderAuditLogList();

        alert(`All ${currentCount} audit logs cleared successfully. Checkpoint recorded.`);
    } catch (err) {
        console.error("Failed to clear audit logs:", err);
        alert("Failed to clear audit logs. Please check your network connection and permissions.");
    } finally {
        if (clearBtn) {
            clearBtn.disabled = false;
            clearBtn.innerHTML = '<i class="fas fa-trash-alt text-[10px]"></i> <span>Clear Logs</span>';
        }
    }
};

document.getElementById('clear-audit-logs-btn')?.addEventListener('click', handleClearAuditLogs);

document.getElementById('add-academic-year-btn').addEventListener('click', async () => {
    if(!requirePermission('academic-years.manage')) return;
    const inputEl = document.getElementById('academic-year-input');
    const errorEl = document.getElementById('academic-year-input-error');
    const labelRaw = String(inputEl?.value || '').trim();
    const status = document.getElementById('academic-year-status').value;
    const startMonth = Number(document.getElementById('academic-year-start-month')?.value ?? 5);
    const endMonth = Number(document.getElementById('academic-year-end-month')?.value ?? 4);

    const showInputError = (message) => {
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
        }
        inputEl?.classList.add('input-error');
        inputEl?.focus();
        alert(message);
    };

    if (!labelRaw) {
        return showInputError('Please enter an academic year in YYYY-YYYY format (e.g. 2025-2026).');
    }

    const match = labelRaw.match(/^(\d{4})-(\d{4})$/);
    if (!match) {
        return showInputError('Invalid format! Must be strictly YYYY-YYYY (e.g. 2024-2025 or 2025-2026).');
    }

    const startYear = Number(match[1]);
    const endYear = Number(match[2]);

    if (startYear < 1990 || startYear > 2100) {
        return showInputError('Start year must be between 1990 and 2100.');
    }

    if (endYear !== startYear + 1) {
        return showInputError(`Consecutive year required! For start year ${startYear}, the end year must be ${startYear + 1} (${startYear}-${startYear + 1}).`);
    }

    const label = `${startYear}-${endYear}`;

    const existing = academicYears.find((year) => year.label === label);
    if (existing) {
        return showInputError(`Academic year "${label}" already exists. Use the 3-dot menu in the card below to edit or activate it.`);
    }

    if (errorEl) errorEl.classList.add('hidden');
    inputEl?.classList.remove('input-error');

    academicYears.push({
        label,
        startYear: Number(startYear),
        endYear: Number(endYear),
        startMonth: Number.isFinite(startMonth) ? startMonth : 5,
        endMonth: Number.isFinite(endMonth) ? endMonth : 4,
        status: status === 'archived' ? 'archived' : 'active',
        classes: getDefaultClassLadder()
    });

    if (status === 'current' || (!activeAcademicYear && status !== 'archived')) {
        activeAcademicYear = label;
        currentAcademicYear = label;
    }
    await persistAcademicYears();
    await ensureFeeItemsForAcademicYears(academicYears);
    await logAuditEvent({ category: 'security', action: 'academic-year.create', entityType: 'academicYear', entityId: label, message: `Academic year created: ${label}.` });
    
    // Set next consecutive year as suggestion in input
    if (inputEl) inputEl.value = `${endYear}-${endYear + 1}`;
    document.getElementById('academic-year-status').value = 'active';
    const startMonthSelect = document.getElementById('academic-year-start-month');
    const endMonthSelect = document.getElementById('academic-year-end-month');
    if (startMonthSelect) startMonthSelect.value = '5';
    if (endMonthSelect) endMonthSelect.value = '4';
    showToast(`Academic year "${label}" created successfully!`, 'success');
    renderAcademicYears();
    refreshAcademicYearScopedData(true);
});

document.getElementById('academic-year-input')?.addEventListener('input', (event) => {
    const errorEl = document.getElementById('academic-year-input-error');
    const val = String(event.target.value || '').trim();
    if (event.target.classList.contains('input-error') && (/^\d{4}-\d{4}$/.test(val) || val.length === 0)) {
        event.target.classList.remove('input-error');
        if (errorEl) errorEl.classList.add('hidden');
    }
    const match = val.match(/^(\d{4})-(\d{4})$/);
    if (match) {
        const found = academicYears.find((y) => y.label === val);
        if (found) {
            const startMonthSelect = document.getElementById('academic-year-start-month');
            const endMonthSelect = document.getElementById('academic-year-end-month');
            const statusSelect = document.getElementById('academic-year-status');
            if (startMonthSelect) startMonthSelect.value = String(found.startMonth ?? 5);
            if (endMonthSelect) endMonthSelect.value = String(found.endMonth ?? 4);
            if (statusSelect) statusSelect.value = found.status || 'planning';
        }
    }
});

document.getElementById('academic-years-list')?.addEventListener('change', (e) => {
    const statusSelect = e.target.closest('.year-status-select');
    if (!statusSelect) return;
    const initialStatus = statusSelect.dataset.initialStatus;
    const currentVal = statusSelect.value;
    const card = statusSelect.closest('[data-card-year]');
    const saveBtn = card?.querySelector('.save-year-status-btn');
    if (saveBtn) {
        if (currentVal !== initialStatus) {
            saveBtn.classList.remove('hidden');
            saveBtn.classList.add('inline-flex');
        } else {
            saveBtn.classList.add('hidden');
            saveBtn.classList.remove('inline-flex');
        }
    }
});

document.getElementById('academic-years-list').addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('.save-year-status-btn');
    const activateBtn = e.target.closest('.set-active-year-btn');
    const archiveBtn = e.target.closest('.archive-year-btn');
    const menuToggleBtn = e.target.closest('.year-menu-toggle');
    const editBtn = e.target.closest('.year-edit-btn');
    const deleteBtn = e.target.closest('.year-delete-btn');

    if (saveBtn) {
        if(!requirePermission('academic-years.manage')) return;
        const label = saveBtn.dataset.label;
        const card = saveBtn.closest('[data-card-year]');
        const statusSelect = card?.querySelector('.year-status-select');
        if (!statusSelect) return;
        const newStatus = statusSelect.value;

        if (newStatus === 'current') {
            activeAcademicYear = label;
            academicYears = academicYears.map((year) => {
                if (year.label === label) {
                    return { ...year, status: 'active' };
                }
                return year;
            });
        } else if (newStatus === 'archived') {
            if (label === activeAcademicYear) {
                alert('Current Academic Year cannot be archived. Please set another academic year as Current Academic Year first.');
                statusSelect.value = statusSelect.dataset.initialStatus || 'current';
                saveBtn.classList.add('hidden');
                saveBtn.classList.remove('inline-flex');
                return;
            }
            academicYears = academicYears.map((year) => {
                if (year.label === label) {
                    return { ...year, status: 'archived' };
                }
                return year;
            });
        } else if (newStatus === 'active') {
            if (label === activeAcademicYear) {
                const otherActiveYear = academicYears.find((y) => y.label !== label && y.status !== 'archived');
                if (otherActiveYear) {
                    activeAcademicYear = otherActiveYear.label;
                } else {
                    alert('At least one academic year must be designated as Current Academic Year.');
                    statusSelect.value = 'current';
                    saveBtn.classList.add('hidden');
                    saveBtn.classList.remove('inline-flex');
                    return;
                }
            }
            academicYears = academicYears.map((year) => {
                if (year.label === label) {
                    return { ...year, status: 'active' };
                }
                return year;
            });
        }

        await persistAcademicYears();
        await logAuditEvent({ category: 'security', action: 'academic-year.update-status', entityType: 'academicYear', entityId: label, message: `Academic year ${label} status updated to ${newStatus}.` });
        showToast(`Academic year "${label}" status saved as ${newStatus === 'current' ? 'Current Academic Year' : (newStatus === 'archived' ? 'Archive' : 'Active')}.`, 'success');
        renderAcademicYears();
        refreshAcademicYearScopedData();
        return;
    }

    if (menuToggleBtn) {
        const holder = menuToggleBtn.closest('.relative');
        document.querySelectorAll('#academic-years-list .year-menu').forEach((menu) => {
            if (!holder || menu !== holder.querySelector('.year-menu')) menu.classList.add('hidden');
        });
        holder?.querySelector('.year-menu')?.classList.toggle('hidden');
        return;
    }

    if (editBtn) {
        if(!requirePermission('academic-years.manage')) return;
        openAcademicYearEditPopup(editBtn.dataset.label || '');
        return;
    }

    if (deleteBtn) {
        if(!requirePermission('academic-years.manage')) return;
        const label = deleteBtn.dataset.label;
        if (label === activeAcademicYear) return alert('Active academic year cannot be deleted.');
        const studentsInYear = rawStudents.filter((student) => (student.academicYear || '') === label).length;
        if (studentsInYear > 0) return alert('Cannot delete academic year with student records. Archive it instead.');
        if (!confirm(`Delete academic year ${label}? This cannot be undone.`)) return;
        academicYears = academicYears.filter((year) => year.label !== label);
        await persistAcademicYears();
        await logAuditEvent({ category: 'security', action: 'academic-year.delete', entityType: 'academicYear', entityId: label, message: `Academic year deleted: ${label}.` });
        return;
    }

    if (activateBtn) {
        if(!requirePermission('academic-years.manage')) return;
        activeAcademicYear = activateBtn.dataset.label;
        academicYears = academicYears.map((year) => ({
            ...year,
            status: year.label === activeAcademicYear ? 'active' : (year.status === 'active' ? 'planning' : year.status)
        }));
        await persistAcademicYears();
        await logAuditEvent({ category: 'security', action: 'academic-year.activate', entityType: 'academicYear', entityId: activeAcademicYear, message: `Academic year activated: ${activeAcademicYear}.` });
        return;
    }

    if (archiveBtn) {
        if(!requirePermission('academic-years.manage')) return;
        const label = archiveBtn.dataset.label;
        if (label === activeAcademicYear) return alert('Set another academic year as active before archiving this one.');
        academicYears = academicYears.map((year) => year.label === label ? { ...year, status: 'archived' } : year);
        await persistAcademicYears();
        await logAuditEvent({ category: 'security', action: 'academic-year.archive', entityType: 'academicYear', entityId: label, message: `Academic year archived: ${label}.` });
    }
});
document.getElementById('academic-year-edit-cancel')?.addEventListener('click', closeAcademicYearEditPopup);
document.getElementById('academic-year-edit-save')?.addEventListener('click', async () => {
    if(!requirePermission('academic-years.manage')) return;
    const label = document.getElementById('academic-year-edit-target-label')?.value || '';
    if (!label) return;
    const normalizedStatus = String(document.getElementById('academic-year-edit-status')?.value || 'active').trim().toLowerCase();
    const startMonth = Number(document.getElementById('academic-year-edit-start-month')?.value ?? 5);
    const endMonth = Number(document.getElementById('academic-year-edit-end-month')?.value ?? 4);
    if (!['active', 'current', 'archived'].includes(normalizedStatus)) return alert('Status must be Current Academic Year, Active, or Archive.');
    if (!Number.isInteger(startMonth) || startMonth < 0 || startMonth > 11 || !Number.isInteger(endMonth) || endMonth < 0 || endMonth > 11) return alert('Start/End month must be between 0 and 11.');
    if (label === activeAcademicYear && normalizedStatus === 'archived') return alert('Current Academic Year cannot be archived. Please set another academic year as Current Academic Year first.');

    academicYears = academicYears.map((year) => year.label === label ? { ...year, status: normalizedStatus === 'archived' ? 'archived' : 'active', startMonth, endMonth } : year);
    if (normalizedStatus === 'current') {
        activeAcademicYear = label;
        currentAcademicYear = label;
        academicYears = academicYears.map((year) => ({
            ...year,
            status: year.label === activeAcademicYear ? 'active' : (year.status === 'archived' ? 'archived' : 'active')
        }));
    } else if (normalizedStatus === 'active' && label === activeAcademicYear) {
        const otherActive = academicYears.find((y) => y.label !== label && y.status !== 'archived');
        if (otherActive) {
            activeAcademicYear = otherActive.label;
        }
    }
    await persistAcademicYears();
    await ensureFeeItemsForAcademicYears(academicYears);
    await logAuditEvent({ category: 'security', action: 'academic-year.update', entityType: 'academicYear', entityId: label, message: `Academic year updated: ${label}.` });
    closeAcademicYearEditPopup();
    showToast(`Academic year "${label}" updated.`, 'success');
    renderAcademicYears();
    refreshAcademicYearScopedData(normalizedStatus === 'current');
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('#academic-years-list .relative')) {
        document.querySelectorAll('#academic-years-list .year-menu').forEach((menu) => menu.classList.add('hidden'));
    }
});
populateAcademicMonthSelectors();
populateAcademicYearPresetSelector();

// --- AUTH & FIREBASE INIT ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        await signInAnonymously(auth);
        return;
    }
    const requestedTab = (window.location.hash || '#dashboard').replace('#', '') || 'dashboard';
    if (requestedTab === 'results') {
        window.location.replace('result.html?from=admin');
        return;
    }
    window.AppSession?.touchSession();

    try {
        const adminRef = getAdminAuthRef();
        const snap = await getDoc(adminRef);
        currentAdminEmail = normalizeEmail(user.email || '');
        const legacyEmail = normalizeEmail(snap.exists() ? snap.data().email : 'admin@institute.com');
        const availableAdmins = SINGLE_ADMIN_MODE ? normalizeAdminAccounts([], legacyEmail) : normalizeAdminAccounts(snap.exists() ? snap.data().admins || [] : [], legacyEmail);
        const matchingAdmin = availableAdmins.find((account) => account.email === currentAdminEmail && account.isActive);
        const wantsResultsTab = false;

        if (!matchingAdmin) {
            const staffEmailFromSession = normalizeEmail(window.AppSession?.getStaffEmail?.() || window.AppSession?.getStaffAccess?.()?.userKey || currentAdminEmail || '');
            let authorizedStaffAdmin = null;
            if (staffEmailFromSession) {
                const staffSnap = await getDocs(query(collection(db, `${BASE_PATH}/staff`), where('email', '==', staffEmailFromSession)));
                let staffDocFound = staffSnap.docs.find(d => {
                    const row = d.data();
                    return row.isActive !== false && row.canAccessAdmin === true;
                });
                if (!staffDocFound) {
                    const allStaffSnap = await getDocs(collection(db, `${BASE_PATH}/staff`));
                    staffDocFound = allStaffSnap.docs.find(d => {
                        const row = d.data();
                        const sEmail = (row.email || '').toLowerCase().trim();
                        const sUsername = (row.username || '').toLowerCase().trim();
                        return (sEmail === staffEmailFromSession || sUsername === staffEmailFromSession) && row.isActive !== false && row.canAccessAdmin === true;
                    });
                }
                if (staffDocFound) {
                    authorizedStaffAdmin = { id: staffDocFound.id, ...staffDocFound.data() };
                }
            }
            if (!authorizedStaffAdmin && (window.AppSession?.getStaffAccess?.()?.canAccessAdmin === true || window.AppSession?.getStaffAccess?.()?.admin === true)) {
                const access = window.AppSession.getStaffAccess();
                authorizedStaffAdmin = {
                    name: window.AppSession.getStaffName?.() || '',
                    email: staffEmailFromSession,
                    canAccessAdmin: true,
                    actLikeSuperAdmin: access?.actLikeSuperAdmin === true
                };
            }
            if (!authorizedStaffAdmin && window.AppSession?.getRole?.() === 'admin') {
                // Allowed via master admin session
                currentAdminRole = 'super_admin';
            } else if (authorizedStaffAdmin) {
                isStaffAdminSession = true;
                staffAdminRecord = authorizedStaffAdmin;
                currentAdminRole = authorizedStaffAdmin.actLikeSuperAdmin === true ? 'super_admin' : 'operations_admin';
                currentAdminEmail = staffEmailFromSession;
                // Preserve staff identity in session rather than generic admin
                window.AppSession?.startStaff(authorizedStaffAdmin.name || window.AppSession?.getStaffName?.() || '', staffEmailFromSession, {
                    ...(window.AppSession?.getStaffAccess?.() || {}),
                    collection: authorizedStaffAdmin.canCollect !== false,
                    result: authorizedStaffAdmin.canManageResults === true,
                    worksheet: authorizedStaffAdmin.canAccessWorksheet !== false,
                    admin: true,
                    canAccessAdmin: true,
                    actLikeSuperAdmin: authorizedStaffAdmin.actLikeSuperAdmin === true,
                    staffId: authorizedStaffAdmin.id || '',
                    role: authorizedStaffAdmin.role || authorizedStaffAdmin.type || 'Staff',
                    type: authorizedStaffAdmin.type || 'Staff',
                    phone: authorizedStaffAdmin.phone || '',
                    photo: authorizedStaffAdmin.photo || ''
                });
            } else if (!wantsResultsTab) {
                alert("Unauthorized access! You do not have permission to view this page.");
                await window.AppSession?.clearAll({ purgeClientData: true });
                await signOut(auth);
                window.location.href = 'index.html';
                return;
            } else {
                const staffSnap = await getDocs(query(collection(db, `${BASE_PATH}/staff`), where('email', '==', currentAdminEmail)));
                const staffRow = staffSnap.docs[0]?.data() || null;
                if (!staffRow || staffRow.isActive === false || staffRow.canManageResults !== true) {
                    alert("Result page access denied. Ask admin to enable your staff/collection access.");
                    await window.AppSession?.clearAll({ purgeClientData: true });
                    await signOut(auth);
                    window.location.href = 'index.html';
                    return;
                }
                isResultOperatorSession = true;
                currentAdminRole = 'result_operator';
                window.AppSession?.startStaff(staffRow.name || 'Result Operator', currentAdminEmail);
            }
        } else {
            currentAdminRole = matchingAdmin.role || 'super_admin';
            window.AppSession?.startAdmin();
        }

        document.getElementById('auth-loader').style.display = 'none';
        document.getElementById('admin-app').style.display = 'block';
        applyRoleAccessUI();
        ensureActiveAdminPageAccess();
        enforceResultOperatorModeUI();
        renderSessionMonitor();

        if (!snap.exists()) {
            const seedAdmins = availableAdmins.length ? availableAdmins : [{ name: 'Master Admin', email: currentAdminEmail || 'admin@institute.com', role: 'super_admin', isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
            await setDoc(adminRef, buildAdminAuthPayload(currentAdminEmail || 'admin@institute.com', seedAdmins), { merge: true });
        }

        const configRef = doc(db, `${BASE_PATH}/settings`, 'config');
        const academicYearsRef = doc(db, `${BASE_PATH}/settings`, 'academicYears');
        const sessionControlRef = doc(db, `${BASE_PATH}/settings`, 'sessionControl');
        const sessionRegistryRef = getSessionRegistryRef();

        onSnapshot(adminRef, (adminSnap) => {
            const adminData = adminSnap.exists() ? adminSnap.data() : {};
            adminAccounts = SINGLE_ADMIN_MODE ? normalizeAdminAccounts([], normalizeEmail(adminData.email || currentAdminEmail)) : normalizeAdminAccounts(adminData.admins || [], normalizeEmail(adminData.email || currentAdminEmail));
            const currentAccount = adminAccounts.find((account) => account.email === currentAdminEmail && account.isActive);
            if (!currentAccount) {
                if (isStaffAdminSession) {
                    applyRoleAccessUI();
                    ensureActiveAdminPageAccess();
                    renderDashboard();
                    return;
                }
                if (isResultOperatorSession) {
                    currentAdminRole = 'result_operator';
                    applyRoleAccessUI();
                    ensureActiveAdminPageAccess();
                    enforceResultOperatorModeUI();
                    return;
                }
                alert('Your admin access was removed or disabled. Please sign in again.');
                window.logoutAdmin();
                return;
            }
            currentAdminRole = currentAccount.role || 'super_admin';
            const canAccessAdminPanel = currentAdminRole === 'super_admin' || currentAdminRole === 'result_operator' || hasPermission('results.manage');
            if (!canAccessAdminPanel) {
                if (!hasRedirectedNonSuperAdmin) {
                    hasRedirectedNonSuperAdmin = true;
                    alert('Admin panel access is restricted. Redirecting to Collection panel.');
                    window.location.href = 'collection.html';
                }
                return;
            }
            applyRoleAccessUI();
            ensureActiveAdminPageAccess();
            renderAdminRoleList();
            renderDashboard();
            startSessionRegistryHeartbeat();
        });

        if (isStaffAdminSession && staffAdminRecord?.id) {
            onSnapshot(doc(db, `${BASE_PATH}/staff`, staffAdminRecord.id), (staffDocSnap) => {
                const sData = staffDocSnap.exists() ? staffDocSnap.data() : null;
                if (!sData || sData.isActive === false || sData.canAccessAdmin !== true) {
                    alert('Your staff admin access was removed or disabled. Please sign in again.');
                    window.logoutAdmin();
                    return;
                }
                currentAdminRole = sData.actLikeSuperAdmin === true ? 'super_admin' : 'operations_admin';
                applyRoleAccessUI();
                ensureActiveAdminPageAccess();
            });
        }
        onSnapshot(sessionControlRef, (sessionSnap) => {
            sessionControl = sessionSnap.exists() ? sessionSnap.data() : {};
            renderSessionMonitor();
            const startedAt = window.AppSession?.getStartedAt?.() || 0;
            const forcedAt = sessionControl?.lastForcedLogoutAt ? new Date(sessionControl.lastForcedLogoutAt).getTime() : 0;
            if (forcedAt && startedAt && forcedAt > startedAt) {
                alert(sessionControl.message || 'An administrator ended this session. Please sign in again.');
                window.logoutAdmin();
            }
        });
        onSnapshot(sessionRegistryRef, (sessionRegistrySnap) => {
            sessionRegistry = sessionRegistrySnap.exists() ? sessionRegistrySnap.data() : { sessions: {} };
            renderSessionMonitor();
        });
        onSnapshot(collection(db, `${BASE_PATH}/auditLogs`), (auditSnap) => {
            auditLogs = auditSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            renderAuditLogList();
            renderDashboard();
        });

        onSnapshot(academicYearsRef, async (academicSnap) => {
            if (!academicSnap.exists()) {
                academicYears = [{
                    label: currentAcademicYear,
                    startYear: parseInt(currentAcademicYear.split('-')[0], 10),
                    endYear: parseInt(currentAcademicYear.split('-')[1], 10),
                    startMonth: 5,
                    endMonth: 4,
                    status: 'active',
                    classes: getDefaultClassLadder()
                }];
                activeAcademicYear = currentAcademicYear;
                await persistAcademicYears();
                renderAcademicYears();
                refreshAcademicYearScopedData();
                return;
            }

            const data = academicSnap.data();
            academicYears = Array.isArray(data.years) && data.years.length ? data.years : [{
                label: currentAcademicYear,
                startYear: parseInt(currentAcademicYear.split('-')[0], 10),
                endYear: parseInt(currentAcademicYear.split('-')[1], 10),
                startMonth: 5,
                endMonth: 4,
                status: 'active',
                classes: getDefaultClassLadder()
            }];
            academicYears = academicYears.map((year) => ({
                ...year,
                label: sanitizeAcademicYearLabel(year.label || `${year.startYear}-${year.endYear}`),
                startMonth: Number.isFinite(Number(year.startMonth)) ? Number(year.startMonth) : 5,
                endMonth: Number.isFinite(Number(year.endMonth)) ? Number(year.endMonth) : 4,
                classes: (() => {
                    const normalized = sortClassLabels(Array.isArray(year.classes) ? year.classes.map((name) => name?.toString().trim().toUpperCase()).filter(Boolean) : []);
                    return normalized.length ? normalized : getDefaultClassLadder();
                })()
            }));
            activeAcademicYear = sanitizeAcademicYearLabel(data.currentYear || academicYears.find((year) => year.status === 'active')?.label || currentAcademicYear);
            populateAcademicYearPresetSelector();
            const yearInput = document.getElementById('academic-year-input');
            const statusSelect = document.getElementById('academic-year-status');
            const startMonthSelect = document.getElementById('academic-year-start-month');
            const endMonthSelect = document.getElementById('academic-year-end-month');
            const activeYearRecord = academicYears.find((year) => year.label === activeAcademicYear) || {};
            if (statusSelect) statusSelect.value = activeYearRecord.status || 'active';
            if (startMonthSelect) startMonthSelect.value = String(activeYearRecord.startMonth ?? 5);
            if (endMonthSelect) endMonthSelect.value = String(activeYearRecord.endMonth ?? 4);
            renderAcademicYears();
            refreshAcademicYearScopedData();
        });

        onSnapshot(configRef, (docSnap) => {
            const d = docSnap.exists() ? docSnap.data() : {};

            // --- AUTO GENERATE 12 MONTHS FOR ACADEMIC YEARS ---
            let existingItems = Array.isArray(d.feeItems) ? [...d.feeItems] : [];
            let isUpdated = false;
            const targetYears = (Array.isArray(academicYears) && academicYears.length)
                ? academicYears
                : (getActiveAcademicYearRecord() ? [getActiveAcademicYearRecord()] : []);

            targetYears.forEach((yearRecord) => {
                if (!yearRecord || !yearRecord.label || yearRecord.status === 'archived') return;
                const yearLabel = yearRecord.label;
                const suffix = yearLabel.replace(/[^0-9]/g, '').substring(2);
                const months = getAcademicMonthSequence(yearRecord).map((monthIndex) => MONTH_LABELS[monthIndex]);

                months.forEach((m) => {
                    const key = `${m.toLowerCase().substring(0, 3)}-${suffix}`;
                    if (!existingItems.find((i) => i.key === key)) {
                        existingItems.push({
                            key: key,
                            name: `${m} (${yearLabel})`,
                            type: 'month',
                            isVisible: true,
                            academicYear: yearLabel
                        });
                        isUpdated = true;
                    }
                });
            });

            if (isUpdated) {
                setDoc(configRef, { feeItems: existingItems, appName: d.appName || 'Fee Tracker Pro', defaultFee: d.defaultFee || 200 }, { merge: true });
            }

            document.getElementById('app-name-header').textContent = d.appName || 'Admin Dashboard';
            document.getElementById('footer-inst-name').textContent = d.appName || 'Institution Name';
            renderVersionInfo();
            document.getElementById('app-subtitle-header').textContent = d.appSubtitle || 'Institute Management';
            const effectiveLogoUrl = rememberInstitutionLogo(d.logoUrl || '') || 'assets/images/logo.png';
            ['admin-header-logo', 'admin-loader-logo'].forEach((id) => {
                const logoEl = document.getElementById(id);
                if (!logoEl) return;
                logoEl.src = effectiveLogoUrl;
                logoEl.onerror = () => {
                    logoEl.onerror = null;
                    logoEl.src = 'assets/images/logo.png';
                };
            });
            const setValueIfExists = (id, value = '') => {
                const element = document.getElementById(id);
                if (element) element.value = value;
            };
            setValueIfExists('app-name-input', d.appName || ''); setValueIfExists('app-subtitle-input', d.appSubtitle || '');
            setValueIfExists('web-logo', d.logoUrl || '');
            updateLogoWidgetPreview(d.logoUrl || '');
            setValueIfExists('web-phone', d.contactPhone || '');
            setValueIfExists('web-email', d.contactEmail || ''); setValueIfExists('web-wa', d.socialWhatsapp || '');
            setValueIfExists('web-fb', d.socialFacebook || ''); setValueIfExists('web-ig', d.socialInstagram || '');
            setValueIfExists('web-tg', d.socialTelegram || ''); setValueIfExists('web-yt', d.socialYouTube || '');
            setValueIfExists('web-regno', d.regNo || ''); setValueIfExists('web-place', d.place || '');
            setValueIfExists('pay-account-name', d.paymentAccountName || d.paymentUpiName || '');
            setValueIfExists('pay-upi-number', d.paymentUpiNumber || '');
            setValueIfExists('pay-upi-id', d.paymentUpiId || '');
            setValueIfExists('pay-bank-name', d.paymentBankName || '');
            setValueIfExists('pay-account-number', d.paymentAccountNumber || '');
            setValueIfExists('pay-ifsc', d.paymentIfsc || '');
            setValueIfExists('pay-branch', d.paymentBranch || '');
            document.getElementById('default-fee-input').value = d.defaultFee || 200; document.getElementById('fee-status-title-input').value = d.feeStatusTitle || '';
            document.getElementById('default-fee-receipt-req').checked = d.defaultReceiptMandatory || false;
            setValueIfExists('fee-collect-start-day', String(d.feeCollectionStartDay || 1));
            setValueIfExists('fee-collect-end-day', String(d.feeCollectionEndDay || 10));
            setValueIfExists('fee-notify-mode', d.feeNotifyMode || 'month_start');
            setValueIfExists('fee-notify-days-before', String(d.feeNotifyDaysBefore || 5));
            updateFeeScheduleLiveSummary();

            const photoUploadToggle = document.getElementById('admin-toggle-student-photo-upload');
            if (photoUploadToggle) photoUploadToggle.checked = d.allowStudentPhotoUpload === true;
            const detailsEditToggle = document.getElementById('admin-toggle-student-details-edit');
            if (detailsEditToggle) detailsEditToggle.checked = d.allowStudentDetailsEdit === true;

            feeItems = existingItems;
            renderDashboard();
            if(!document.getElementById('fee-settings-page').classList.contains('hidden')) renderFeeItemsManagement();
        });

        onSnapshot(doc(db, `${BASE_PATH}/settings`, 'content'), (snap) => {
            webContent = snap.exists() ? Object.assign({ notices: [], gallery: [], directoryCategories: [] }, snap.data()) : { notices: [], gallery: [], directoryCategories: [] };
            document.getElementById('web-about').value = webContent.description || '';
            renderWebNotices(); renderWebGallery();
            renderDirectoryCategories();
        });
        onSnapshot(doc(db, `${BASE_PATH}/settings`, 'categoryAuthConfig'), (snap) => {
            categoryAuthConfig = normalizeCategoryAuthConfig(snap.exists() ? snap.data() : {});
            renderDirectoryAuthConfig();
        });
        onSnapshot(doc(db, `${BASE_PATH}/settings`, 'pageAccess'), (snap) => {
            pageAccessConfig = normalizePageAccessConfig(snap.exists() ? snap.data() : {});
            renderDirectoryAccessConfig();
            renderOverrideEntryOptions();
        });
        onSnapshot(collection(db, `${BASE_PATH}/publicDirectory`), (snap) => {
            publicDirectoryEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            renderDirectoryEntries();
        });

        onSnapshot(collection(db, `${BASE_PATH}/students`), (snap) => {
            rawStudents = snap.docs.map(d => ({id: d.id, ...d.data()}));
            refreshAcademicYearScopedData();
            renderAcademicYears();
        });

        onSnapshot(collection(db, `${BASE_PATH}/staff`), async (snap) => {
            allStaff = snap.docs.map(d => ({id: d.id, ...d.data()}));
            await rebuildStaffAccessIndex(allStaff);
            renderDashboard();
            renderAcademicYears();
            if(!document.getElementById('staff-management-page')?.classList.contains('hidden') || !document.getElementById('manage-staff-page')?.classList.contains('hidden')) renderStaffList();
        });

        onSnapshot(collection(db, `${BASE_PATH}/studentGroups`), (snap) => {
            const rawGroups = snap.docs.map(d => ({id: d.id, ...d.data()}));
            studentGroups = Array.from(new Map(rawGroups.map(g => [g.id, g])).values())
                .filter((group) => (group.academicYear || currentAcademicYear) === (activeAcademicYear || currentAcademicYear));
            renderDashboard();
            if(!document.getElementById('manage-groups-page').classList.contains('hidden')) renderStudentGroups();
        });

        onSnapshot(collection(db, `${BASE_PATH}/payments`), (snap) => {
            allPayments = snap.docs.map(d => ({id: d.id, ...d.data()}));
        });

        // Result module fully moved to standalone result.html/result-page.js.

    } catch (error) {
        console.error("Auth Error:", error);
        alert("Security verification error occurred.");
        window.location.href = 'index.html';
    }
});
