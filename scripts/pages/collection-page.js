import { signOut, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, onSnapshot, collection, getDocs, writeBatch, setDoc, query, where, getDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, auth } from '../../config/firebase-config.js';
import { ADMIN_AUTH_DOC_ID, SINGLE_ADMIN_MODE } from '../../config/app-config.js';
import { BASE_PATH, applyInstitutionBranding, buildEmptyState, enableSmartSelectWindowing, escapeHtml, fitTextToContainer, formatCurrency, formatMonthLabel, hardenExternalLinks, registerServiceWorker, renderVersionInfo } from '../shared/app-common.js';
import { appLog } from '../shared/logger.js';
import { showToast } from '../shared/toaster.js';
import { initCollectionEntryModule } from './collection/entry-module.js';
import { initCollectionHistoryModule } from './collection/history-module.js';
import { initCollectionReportsModule } from './collection/reports-module.js';
import { initCollectionUploadModule } from './collection/upload-module.js';
import { initCollectionSettingsModule } from './collection/settings-module.js';
import { initMasterLedgerModule, updateMasterLedgerData } from './collection/master-ledger-module.js';
import { initSharedFeeModal, openFeeEntryEditModal } from './collection/shared-fee-modal.js';

// --- GLOBAL STATE (Initialized early to prevent Temporal Dead Zone ReferenceErrors) ---
let isCurrentAdmin = false;
let currentUserEmail = '';
let currentCollectorKey = '';
let students = [], allStudentsRaw = [], allPayments = [], allDonations = [], classes = [], studentGroups = [], feeItems = [], allStaff = [];
let directoryEntries = [], directoryCategories = [], pageAccessConfig = { categories: {}, overrides: {} };
let defaultFee = 200, feeStatusTitle = '', defaultReceiptMandatory = false;
let currentWorkingAcademicYear = '';
let isEditMode = false, editingPaymentGroup = {}, selectedStudentId = null;
let userExplicitClass = '', userExplicitGender = '';
let selectedGroupMemberIds = new Set();
let editTouchedItemKeys = new Set();
let availableFeeAcademicYears = [];
let selectedFeeAcademicYear = '';
let selectedDutyClasses = [];
let pendingFeeSelectionsByYear = {};
let isPaymentMutationInFlight = false;

window.AppSession?.guardStaffPageAccess?.('collection');

appLog('info', 'collection.bootstrap', 'Collection page loaded');
window.notifyApp = (message = '', type = 'info') => showToast(message, type);

export const hideLoader = () => {
    if (typeof window.hideCollectionLoader === 'function') {
        window.hideCollectionLoader();
    } else {
        const loader = document.getElementById('loading-screen');
        if (loader) {
            loader.style.pointerEvents = 'none';
            loader.style.opacity = '0';
            setTimeout(() => { 
                if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
                else if (loader) loader.style.display = 'none';
            }, 200);
        }
    }
};

hideLoader();
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    hideLoader();
} else {
    window.addEventListener('load', hideLoader);
    document.addEventListener('DOMContentLoaded', hideLoader);
}
setTimeout(hideLoader, 200);
setTimeout(hideLoader, 500);

initCollectionEntryModule();
initCollectionHistoryModule();
initCollectionReportsModule();
initCollectionUploadModule();
initCollectionSettingsModule();
initMasterLedgerModule();
initSharedFeeModal();

registerServiceWorker();
hardenExternalLinks();
enableSmartSelectWindowing(document, { visibleCount: 6 });
const syncCollectionPwaMode = () => {
    const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true;
    document.body.classList.toggle('pwa-standalone', Boolean(isStandalone));
};
syncCollectionPwaMode();
window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', syncCollectionPwaMode);

const NON_TOGGLE_TAB_TARGETS = new Set(['dashboard-page']);
const getSessionCollectorKey = () => {
    const access = window.AppSession?.getStaffAccess?.() || {};
    const fallback = window.AppSession?.getStaffEmail?.() || '';
    return String(access.userKey || access.loginId || fallback || '').trim().toLowerCase();
};
const getTabPrefsStorageKey = () => `collector_tab_prefs_${getSessionCollectorKey() || 'default'}`;
const readTabPrefsFromLocal = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(getTabPrefsStorageKey()) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
};
const writeTabPrefsToLocal = (prefs = {}) => {
    localStorage.setItem(getTabPrefsStorageKey(), JSON.stringify(prefs));
};

const getCollectorPrefsRef = () => doc(db, `${BASE_PATH}/collectorPreferences`, getSessionCollectorKey() || 'default');
const readTabPrefsFromCloud = async () => {
    try {
        const snap = await getDoc(getCollectorPrefsRef());
        if (!snap.exists()) return null;
        const prefs = snap.data()?.menuTabs;
        return prefs && typeof prefs === 'object' ? prefs : null;
    } catch (error) {
        console.warn('Unable to read cloud menu settings.', error);
        return null;
    }
};
const writeTabPrefsToCloud = async (prefs = {}) => {
    try {
        await setDoc(getCollectorPrefsRef(), {
            userKey: getSessionCollectorKey(),
            menuTabs: prefs,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (error) {
        console.warn('Unable to save cloud menu settings.', error);
    }
};


// Hamburger Menu Logic
const mobileToggle = document.getElementById('mobile-menu-btn');
const navMenu = document.querySelector('.nav-menu');
const toggleIcon = mobileToggle.querySelector('i.fas.fa-bars') || mobileToggle.querySelector('i');
const setMobileMenuState = (isOpen) => {
    navMenu.classList.toggle('active', isOpen);
    mobileToggle.classList.toggle('active-toggle', isOpen);
    mobileToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
};

mobileToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setMobileMenuState(!navMenu.classList.contains('active'));
});

document.addEventListener('click', (e) => {
    if (!navMenu.contains(e.target) && !mobileToggle.contains(e.target)) {
        setMobileMenuState(false);
    }
});

// TABS LOGIC (Main Tab & Sub-Tab Hierarchy)
const MAIN_TAB_GROUPS = {
    dashboard: ['dashboard-page'],
    collection: ['home-page', 'bulk-upload-page', 'donation-page'],
    ledgers: ['fee-page', 'master-ledger-page', 'conc-group-page'],
    reports: ['history-page', 'monthly-collected-page', 'collector-wise-monthly-page'],
    students: ['students-page']
};

const links = Array.from(document.querySelectorAll('.tab-link'));
const pages = Array.from(document.querySelectorAll('.page-content'));
const defaultTabId = 'dashboard-page';
const linkItems = links.map((link) => ({
    link,
    target: link.dataset.target,
    listItem: link.closest('li'),
    isBottomNav: link.dataset.bottomNav === 'true'
}));
const getToggleableLinks = () => linkItems.filter((item) => item.target && !item.isBottomNav && !NON_TOGGLE_TAB_TARGETS.has(item.target));

const isSubTabAllowedAndVisible = (targetId) => {
    if (targetId === 'collector-wise-monthly-page' && !isCurrentAdmin) return false;
    const prefs = readTabPrefsFromLocal();
    if (!NON_TOGGLE_TAB_TARGETS.has(targetId) && prefs[targetId] === false) return false;
    return true;
};

const applyTabVisibilityPreferences = () => {
    const prefs = readTabPrefsFromLocal();
    getToggleableLinks().forEach(({ target, listItem }) => {
        if (target === 'collector-wise-monthly-page' && !isCurrentAdmin) {
            listItem?.classList.add('hidden');
            return;
        }
        const isVisible = prefs[target] !== false;
        listItem?.classList.toggle('hidden', !isVisible);
    });

    // Hide entire Main Group section in side menu if all its sub-tabs are hidden
    Object.entries(MAIN_TAB_GROUPS).forEach(([groupKey, targets]) => {
        if (groupKey === 'dashboard') return;
        const hasAnyVisible = targets.some((t) => isSubTabAllowedAndVisible(t));
        const menuGroupLi = document.querySelector(`.nav-group-static[data-menu-group="${groupKey}"]`);
        menuGroupLi?.classList.toggle('hidden', !hasAnyVisible);
    });

    const currentTarget = getTargetFromHash(window.location.hash);
    if (!isSubTabAllowedAndVisible(currentTarget)) {
        activateTab(defaultTabId);
    }
};

const getLinkForTarget = (targetId) => links.find(link => link.dataset.target === targetId && !link.dataset.bottomNav) || links.find(link => link.dataset.target === targetId);
const getTargetFromHash = (hashValue) => {
    if (!hashValue) return defaultTabId;
    const normalizedHash = hashValue.startsWith('#') ? hashValue : `#${hashValue}`;
    const matchedLink = links.find(link => link.getAttribute('href') === normalizedHash);
    return matchedLink?.dataset.target || defaultTabId;
};

const syncMasterLedgerState = () => {
    try {
        updateMasterLedgerData({
            students: Array.isArray(students) ? students : [],
            groups: Array.isArray(studentGroups) ? studentGroups : [],
            payments: Array.isArray(allPayments) ? allPayments : [],
            classes: Array.isArray(classes) ? classes : [],
            defaultFee: typeof defaultFee === 'number' ? defaultFee : 200,
            academicYear: currentWorkingAcademicYear || '',
            academicYearSettings: Array.isArray(academicYearSettings) ? academicYearSettings : []
        });
    } catch (err) {
        console.warn('Sync master ledger error:', err);
    }
};
window.syncMasterLedgerState = syncMasterLedgerState;

const activateTab = (targetId, { updateHash = true } = {}) => {
    const safeTargetId = document.getElementById(targetId) ? targetId : defaultTabId;
    const activeLink = getLinkForTarget(safeTargetId);
    if (!activeLink) return;

    links.forEach(link => {
        const isActive = link.dataset.target === safeTargetId;
        link.classList.toggle('active', isActive);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    pages.forEach(page => {
        page.classList.toggle('hidden', page.id !== safeTargetId);
    });

    const mainApp = document.getElementById('app');
    if (mainApp) {
        if (safeTargetId === 'master-ledger-page' || safeTargetId === 'fee-page') {
            mainApp.style.maxWidth = '99vw';
            mainApp.style.width = '99vw';
            mainApp.style.padding = '12px 10px';
            document.body.classList.add('ledger-fullwidth');
            if (safeTargetId === 'master-ledger-page') syncMasterLedgerState();
            if (safeTargetId === 'fee-page' && typeof renderFeeTable === 'function') renderFeeTable();
        } else {
            mainApp.style.maxWidth = '';
            mainApp.style.width = '';
            mainApp.style.padding = '';
            document.body.classList.remove('ledger-fullwidth');
        }
    }

    if (updateHash) {
        const nextHash = activeLink.getAttribute('href');
        if (nextHash && window.location.hash !== nextHash) {
            history.pushState({ collectionTab: safeTargetId }, '', nextHash);
        }
    }

    setMobileMenuState(false);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    if (safeTargetId === 'conc-group-page' && typeof renderConcessionGroupOverview === 'function') {
        renderConcessionGroupOverview();
    }
    window.dispatchEvent(new CustomEvent('tabChanged', { detail: { tab: safeTargetId } }));
};

links.forEach(link => {
    link.addEventListener('click', (e) => {
        if (!link.dataset.target) return;
        e.preventDefault();
        activateTab(link.dataset.target);
    });
});

window.addEventListener('hashchange', () => {
    activateTab(getTargetFromHash(window.location.hash), { updateHash: false });
});
window.addEventListener('popstate', () => {
    activateTab(getTargetFromHash(window.location.hash), { updateHash: false });
});

activateTab(getTargetFromHash(window.location.hash), { updateHash: false });
applyTabVisibilityPreferences();
readTabPrefsFromCloud().then((cloudPrefs) => {
    if (!cloudPrefs) return;
    writeTabPrefsToLocal(cloudPrefs);
    applyTabVisibilityPreferences();
});

// Modals close logic
const closeStudentProfileModal = () => {
    const popup = document.getElementById('student-profile-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }
};
document.getElementById('confirm-cancel')?.addEventListener('click', () => { document.getElementById('confirm-popup').classList.add('hidden'); });
document.getElementById('close-profile-btn')?.addEventListener('click', closeStudentProfileModal);
document.getElementById('close-profile-footer-btn')?.addEventListener('click', closeStudentProfileModal);
document.getElementById('student-profile-popup')?.addEventListener('click', (e) => {
    if (e.target.id === 'student-profile-popup') closeStudentProfileModal();
});
document.getElementById('close-my-profile-btn')?.addEventListener('click', () => { document.getElementById('my-profile-popup').classList.add('hidden'); });
document.getElementById('close-tab-settings-btn')?.addEventListener('click', () => { document.getElementById('tab-settings-popup').classList.add('hidden'); });

// Navigation button actions
document.getElementById('new-fee-entry-btn')?.addEventListener('click', () => { activateTab('home-page'); });
document.getElementById('back-to-official-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = 'official.html';
});
let isDonationSaveInFlight = false;
let collectorPaymentDetails = {
    accountName: '',
    upiNumber: '',
    upiId: '',
};
const setResultPageNavVisibility = (canAccess = false) => {
    const navItem = document.getElementById('result-nav-item');
    if (!navItem) return;
    navItem.classList.toggle('hidden', !canAccess);
};
const normalizeEmail = (email = '') => String(email || '').trim().toLowerCase();
const getEffectiveStaffEmail = () => normalizeEmail(currentUserEmail || window.AppSession?.getStaffEmail?.() || auth.currentUser?.email || '');
const getCollectorKey = () => normalizeEmail(currentCollectorKey || window.AppSession?.getStaffAccess?.()?.userKey || window.AppSession?.getStaffAccess?.()?.loginId || getEffectiveStaffEmail());
const getCollectorDisplayName = () => {
    const key = getCollectorKey();
    const staffMatch = allStaff.find(s => normalizeEmail(s.email) === key || String(s.loginId || '').trim().toLowerCase() === key || normalizeEmail(s.name) === key);
    if (staffMatch?.name) return staffMatch.name;
    if (window.AppSession?.getStaffName?.()) return window.AppSession.getStaffName();
    if (isCurrentAdmin && !window.AppSession?.getStaffAccess?.()) return 'Administrator';
    return currentUserEmail || key || 'Collector';
};
window.getCollectorKey = getCollectorKey;
window.getCollectorDisplayName = getCollectorDisplayName;
const getDutyUserKey = () => getCollectorKey();
const getDutyStorageKey = () => `collector_duty_classes_${getDutyUserKey()}`;
const getDutyPaymentStorageKey = () => `collector_duty_payment_${getDutyUserKey()}`;
const readDutyClassesFromLocal = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(getDutyStorageKey()) || '[]');
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (error) {
        return [];
    }
};
const readDutyPaymentFromLocal = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(getDutyPaymentStorageKey()) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
};
const hasDutyPaymentDetails = (details = {}) => Object.values(details || {}).some((value) => String(value || '').trim().length > 0);
const getDirectoryCategoryName = (categoryId = '') => directoryCategories.find((category) => category.id === categoryId)?.name || 'Category';
const getDirectoryCollectionAccess = (entry = {}) => {
    const categoryAccess = pageAccessConfig?.categories?.[entry.categoryId] || {};
    const override = pageAccessConfig?.overrides?.[entry.id] || {};
    if (override.blocked === true) return false;
    if (typeof override.collection === 'boolean') return override.collection;
    return categoryAccess.collection === true;
};
const getDirectoryValue = (entry = {}, keys = []) => {
    const values = entry.values || {};
    for (const key of keys) {
        const value = values[key];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
};
const normalizeFeeItemName = (name = '') => String(name || '').replace(/\s*\((?:\d{4}\s*-\s*\d{2,4}|\d{4}\s*-\s*\d{4})\)\s*$/i, '').trim();
const getPaymentItemType = (payment = {}) => {
    if (payment.entryType === 'donation' || payment.itemKey === STUDENT_DONATION_ITEM_KEY) return 'donation';
    if (payment.itemType === 'month') return 'month';
    if (payment.itemType === 'custom') return 'custom';
    const feeItem = feeItems.find((item) => item.key === payment.itemKey);
    if (feeItem?.type === 'month') return 'month';
    if (feeItem?.type === 'custom') return 'custom';
    const key = String(payment.itemKey || '').trim().toLowerCase();
    if (key.startsWith('month-') || key.startsWith('month_') || key.includes('-month-')) return 'month';
    if (MONTH_SEQUENCE.some(m => key === m || key === m.slice(0, 3) || key.startsWith(m))) return 'month';
    return 'custom';
};
const getDutyPaymentDetails = () => ({
    accountName: document.getElementById('duty-pay-account-name')?.value?.trim() || '',
    upiNumber: document.getElementById('duty-pay-upi-number')?.value?.trim() || '',
    upiId: document.getElementById('duty-pay-upi-id')?.value?.trim() || '',
});
const setDutyPaymentDetailsInputs = (details = {}) => {
    const values = { ...collectorPaymentDetails, ...details };
    const setVal = (id, value = '') => { const el = document.getElementById(id); if (el) el.value = value; };
    setVal('duty-pay-account-name', values.accountName || '');
    setVal('duty-pay-upi-number', values.upiNumber || '');
    setVal('duty-pay-upi-id', values.upiId || '');
};

// History Pagination State
let sortedHistoryList = [];
let historyDisplayedCount = 0;
let historyRenderToken = 0;
let historyLoadTimer = null;
let multiEntryQueue = [];
const INITIAL_LOAD = 30;
const LOAD_MORE = 10;
const MONTH_SEQUENCE = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const STUDENT_DONATION_ITEM_KEY = '__student_donation__';
const STUDENT_DONATION_ITEM = {
    key: STUDENT_DONATION_ITEM_KEY,
    name: 'Donation',
    type: 'custom',
    scope: 'global',
    amount: '',
    isVisible: true
};
let editingDonationId = null;
let academicYearSettings = [];
let sessionRegistryHeartbeat = null;
const getSessionRegistryRef = () => doc(db, `${BASE_PATH}/settings`, 'sessionRegistry');
const getLocalDeviceId = () => {
    const key = 'fee_collection_device_id';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const generated = `col-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem(key, generated);
    return generated;
};
const getCollectionSessionUserKey = () => getCollectorKey();
const updateCollectionSessionRegistry = async () => {
    const userKey = getCollectionSessionUserKey();
    if (!userKey) return;
    const deviceId = getLocalDeviceId();
    await setDoc(getSessionRegistryRef(), {
        sessions: {
            [deviceId]: {
                deviceId,
                role: 'collection',
                userKey,
                userName: window.AppSession?.getStaffName?.() || currentUserEmail || 'Collector',
                adminEmail: currentUserEmail || '',
                deviceLabel: navigator.userAgent.includes('Android') ? 'Android Device' : navigator.userAgent.includes('iPhone') ? 'iOS Device' : 'Browser Device',
                platform: navigator.platform || '',
                lastSeenAt: new Date().toISOString(),
                forceLogout: false
            }
        }
    }, { merge: true });
};
const startCollectionSessionHeartbeat = () => {
    if (sessionRegistryHeartbeat) clearInterval(sessionRegistryHeartbeat);
    updateCollectionSessionRegistry().catch((error) => console.error('Failed to update collection session registry.', error));
    sessionRegistryHeartbeat = setInterval(() => {
        updateCollectionSessionRegistry().catch((error) => console.error('Failed to update collection session registry.', error));
    }, 60000);
};
const getAcademicYearRecord = (label = '') => academicYearSettings.find((year) => year?.label === label) || null;
const getAcademicYearStatus = (label = '') => String(getAcademicYearRecord(label)?.status || 'active').toLowerCase();
const isYearVisibleInCollection = (label = '') => getAcademicYearStatus(label) !== 'archived';
const getAcademicMonthSequence = (yearLabel = '') => {
    const yearRecord = getAcademicYearRecord(yearLabel) || {};
    const startMonth = Number.isInteger(Number(yearRecord?.startMonth)) ? Number(yearRecord.startMonth) : 5;
    const endMonth = Number.isInteger(Number(yearRecord?.endMonth)) ? Number(yearRecord.endMonth) : 4;
    const months = [];
    let cursor = startMonth;
    for (let count = 0; count < 24; count += 1) {
        months.push(cursor);
        if (cursor === endMonth) break;
        cursor = (cursor + 1) % 12;
    }
    return months.length ? months : [5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4];
};
const getMonthIndexFromName = (name = '') => {
    const normalized = normalizeFeeItemName(name || '').toLowerCase();
    const matchedMonth = MONTH_SEQUENCE.find((month) => normalized.startsWith(month) || (normalized.length >= 3 && month.startsWith(normalized.slice(0, 3))));
    return matchedMonth ? MONTH_SEQUENCE.indexOf(matchedMonth) : -1;
};
const populateFeeStatusAcademicYears = () => {
    const feeStatusYearSelect = document.getElementById('filter-academic-year');
    if (!feeStatusYearSelect) return;
    const currentVal = feeStatusYearSelect.value;
    const years = (academicYearSettings || []).filter(y => y && y.label && y.status !== 'archived');
    const optionsHtml = years.map(y => `<option value="${escapeHtml(y.label)}">${escapeHtml(y.label)}${y.label === currentWorkingAcademicYear ? ' (Active)' : ''}</option>`).join('');
    feeStatusYearSelect.innerHTML = `<option value="">Current Year (${escapeHtml(currentWorkingAcademicYear || 'Active')})</option>` + optionsHtml;
    if (currentVal && years.some(y => y.label === currentVal)) {
        feeStatusYearSelect.value = currentVal;
    }
};

const sortFeeItemsForDisplay = (items = [], customYear = null) => {
    const effectiveYear = customYear || document.getElementById('filter-academic-year')?.value || selectedFeeAcademicYear || currentWorkingAcademicYear;
    const selectedYearMonthOrder = getAcademicMonthSequence(effectiveYear);
    const monthly = items.filter((item) => (item.type || 'month') === 'month')
        .sort((a, b) => {
            const aLabel = normalizeFeeItemName(a.name || '');
            const bLabel = normalizeFeeItemName(b.name || '');
            const aIndex = getMonthIndexFromName(aLabel);
            const bIndex = getMonthIndexFromName(bLabel);
            const aOrder = selectedYearMonthOrder.indexOf(aIndex);
            const bOrder = selectedYearMonthOrder.indexOf(bIndex);
            if (aOrder === -1 && bOrder === -1) return aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' });
            if (aOrder === -1) return 1;
            if (bOrder === -1) return -1;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' });
        });
    const monthlyKeys = new Set(monthly.map((item) => item.key));
    const custom = items.filter((item) => !monthlyKeys.has(item.key));
    return [...monthly, ...custom];
};
const sortMonthlyItemsByAcademicYear = (items = [], academicYear = '') => {
    const yearMonthOrder = getAcademicMonthSequence(academicYear || selectedFeeAcademicYear || currentWorkingAcademicYear);
    return [...items].sort((a, b) => {
        const aLabel = normalizeFeeItemName(a.name || '');
        const bLabel = normalizeFeeItemName(b.name || '');
        const aOrder = yearMonthOrder.indexOf(getMonthIndexFromName(aLabel));
        const bOrder = yearMonthOrder.indexOf(getMonthIndexFromName(bLabel));
        if (aOrder === -1 && bOrder === -1) return aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' });
        if (aOrder === -1) return 1;
        if (bOrder === -1) return -1;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' });
    });
};

const buildFeeStatusMatrix = () => {
    const fCls = document.getElementById('filter-class')?.value || 'all';
    const fGen = document.getElementById('filter-gender')?.value || 'all';
    const fYear = document.getElementById('filter-academic-year')?.value || currentWorkingAcademicYear;
    const dutyFilteredStudents = (!isCurrentAdmin && selectedDutyClasses.length)
        ? students.filter((student) => selectedDutyClasses.includes(student.class))
        : students;
    const list = dutyFilteredStudents.filter(s => (fCls === 'all' || s.class === fCls) && (fGen === 'all' || s.gender === fGen));
    const items = feeItems.filter((i) => {
        if (i.isVisible === false) return false;
        if (!fYear) return true;
        return (i.academicYear || fYear) === fYear;
    });
    return { list, items };
};

// --- LISTEN FOR TAB CHANGES FROM HTML ---
window.addEventListener('tabChanged', (e) => {
    const targetId = e.detail.tab;
    if (targetId === 'history-page') prepareHistoryData();
    if (targetId === 'fee-page') renderFeeTable();
    if (targetId === 'students-page') renderStudentInfoList();
    if (targetId === 'home-page') exitEditMode();
    if (targetId === 'bulk-upload-page') setupBulkUploadUI();
    if (targetId === 'donation-page') setupDonationEntryUI();
    if (targetId === 'dashboard-page') updateDashboardMetrics();
    if (targetId === 'monthly-collected-page') renderMonthlyCollectedPage(document.getElementById('monthly-collected-search-input').value);
    if (targetId === 'collector-wise-monthly-page') renderCollectorWiseMonthlyPage();
});

// --- GLOBAL EXPORTS (For HTML buttons) ---
window.openStudentProfile = (id) => {
    const s = getStudentById(id);
    if (!s) return;
    const prof = (s.profile && typeof s.profile === 'object') ? s.profile : {};
    const pick = (...vals) => {
        for (const v of vals) {
            if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
    };
    const formatDateIfIso = (val = '') => {
        if (!val) return '-';
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
            const [y, m, d] = val.split('-');
            return `${d}/${m}/${y}`;
        }
        return val;
    };

    // 1. Photo
    const photoUrl = pick(s.photo, prof.photo);
    const photoImg = document.getElementById('prof-photo-img');
    const photoAvatar = document.getElementById('prof-photo-avatar');
    if (photoImg && photoAvatar) {
        if (photoUrl) {
            photoImg.src = photoUrl;
            photoImg.classList.remove('hidden');
            photoAvatar.classList.add('hidden');
            photoImg.onerror = () => {
                photoImg.classList.add('hidden');
                photoAvatar.classList.remove('hidden');
            };
        } else {
            photoImg.src = '';
            photoImg.classList.add('hidden');
            photoAvatar.classList.remove('hidden');
        }
    }

    // 2. Class, 3. UID, 4. Name, 5. Father, 6. Mother, 7. Gender, 8. Adm No, 9. DOB, 10. Adm Date, 11. Status, 12. Aadhaar, 13. Father Phone, 14. Mother Phone, 15. Address
    const setText = (elId, val) => {
        const el = document.getElementById(elId);
        if (el) el.textContent = val || '-';
    };

    setText('prof-name', pick(s.name, prof.name));
    setText('prof-class', pick(s.class, s.studentClass, prof.class));
    setText('prof-gender', pick(s.gender, prof.gender));
    setText('prof-adm', pick(s.adm, prof.admNo, prof.adm));
    setText('prof-uid', pick(s.uid, prof.uid));
    setText('prof-father', pick(s.father, prof.father, s.guardian));
    setText('prof-mother', pick(s.mother, prof.mother));
    setText('prof-dob', formatDateIfIso(pick(prof.dob, s.dob)));
    setText('prof-adm-date', formatDateIfIso(pick(prof.admDate, s.admDate)));
    setText('prof-aadhaar', pick(prof.adhaar, s.adhaar, prof.aadhaar, s.aadhaar));
    setText('prof-addr', pick(s.address, prof.address));

    const statusVal = pick(s.status, prof.status) || 'Active';
    const statusEl = document.getElementById('prof-status');
    if (statusEl) {
        statusEl.textContent = statusVal;
        const lowerStatus = statusVal.toLowerCase();
        statusEl.className = lowerStatus === 'active'
            ? 'px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200'
            : lowerStatus === 'discontinued'
                ? 'px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-rose-100 text-rose-800 border border-rose-200'
                : (lowerStatus === 'alumni' || lowerStatus === 'graduated')
                    ? 'px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-indigo-100 text-indigo-800 border border-indigo-200'
                    : 'px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-slate-200 text-slate-700 border border-slate-300';
    }

    // Fee Concession & Group Details
    const activeGroup = studentGroups.find((group) => Array.isArray(group.memberIds) && group.memberIds.includes(s.id));
    const groupWrap = document.getElementById('prof-group-wrap');
    const groupMembersEl = document.getElementById('prof-group-members');
    const groupAmountEl = document.getElementById('prof-group-amount');
    const hasIndividualConc = s.concessionFee !== undefined && s.concessionFee !== null && String(s.concessionFee).trim() !== '';

    if (activeGroup && groupWrap && groupMembersEl && groupAmountEl) {
        const groupFee = Number(activeGroup.fee || defaultFee || 200);
        setText('prof-conc', hasIndividualConc ? `₹${s.concessionFee}/mo (Group: ₹${groupFee}/mo)` : `Group Rate: ₹${groupFee.toFixed(0)}/mo`);
        groupAmountEl.textContent = `Group Fee: ₹${groupFee.toFixed(0)}/mo`;
        groupMembersEl.innerHTML = (activeGroup.memberIds || []).map((memberId, index) => {
            const member = students.find((student) => student.id === memberId) || allStudentsRaw.find((student) => student.id === memberId) || {};
            const isSelected = memberId === s.id;
            return `
                <div class="flex items-center justify-between gap-2 rounded-lg bg-white border ${isSelected ? 'border-blue-300 bg-blue-50/40' : 'border-blue-100'} px-2.5 py-1.5 text-xs">
                    <span class="${isSelected ? 'font-extrabold text-blue-950' : 'font-bold text-slate-800'} truncate">${index + 1}. ${escapeHtml(member.name || memberId)}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[10px] font-bold">Adm: ${escapeHtml(member.adm || '-')}</span>
                        <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold text-[10px]">Cls: ${escapeHtml(member.class || '-')}</span>
                    </div>
                </div>`;
        }).join('');
        groupWrap.classList.remove('hidden');
    } else {
        setText('prof-conc', hasIndividualConc ? `₹${s.concessionFee}/month` : 'None (Standard Rate)');
        groupWrap?.classList.add('hidden');
        if (groupMembersEl) groupMembersEl.innerHTML = '';
        if (groupAmountEl) groupAmountEl.textContent = '';
    }

    // 13. Father's Phone & Call Button
    const fatherPhone = pick(s.mobile, prof.mobile, s.phone);
    const mobCont = document.getElementById('prof-mobile');
    const callBtn = document.getElementById('prof-call-btn');
    if (mobCont && callBtn) {
        if (fatherPhone) {
            mobCont.textContent = fatherPhone;
            callBtn.href = `tel:${fatherPhone}`;
            callBtn.classList.remove('hidden');
            callBtn.classList.add('inline-flex');
        } else {
            mobCont.textContent = 'Not Available';
            callBtn.classList.add('hidden');
            callBtn.classList.remove('inline-flex');
        }
    }

    // 14. Mother's Phone & Call Button
    const motherPhone = pick(s.motherMobile, prof.motherMobile);
    const motherMobCont = document.getElementById('prof-mother-mobile');
    const motherCallBtn = document.getElementById('prof-mother-call-btn');
    if (motherMobCont && motherCallBtn) {
        if (motherPhone) {
            motherMobCont.textContent = motherPhone;
            motherCallBtn.href = `tel:${motherPhone}`;
            motherCallBtn.classList.remove('hidden');
            motherCallBtn.classList.add('inline-flex');
        } else {
            motherMobCont.textContent = 'Not Available';
            motherCallBtn.classList.add('hidden');
            motherCallBtn.classList.remove('inline-flex');
        }
    }

    const popup = document.getElementById('student-profile-popup');
    if (popup) {
        popup.classList.remove('hidden');
        popup.classList.add('flex');
    }
};

const renderTabSettings = () => {
    const listEl = document.getElementById('tab-settings-list');
    if (!listEl) return;
    const prefs = readTabPrefsFromLocal();
    listEl.innerHTML = getToggleableLinks().map(({ link, target }) => {
        const checked = prefs[target] !== false;
        return `<label class="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-gray-200 bg-gray-50">
            <span class="text-sm font-semibold text-gray-700">${escapeHtml(link.textContent.trim())}</span>
            <input type="checkbox" class="tab-pref-checkbox w-4 h-4" data-target="${target}" ${checked ? 'checked' : ''}>
        </label>`;
    }).join('');
};

document.getElementById('open-tab-settings-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    renderTabSettings();
    document.getElementById('tab-settings-popup')?.classList.remove('hidden');
    document.getElementById('tab-settings-popup')?.classList.add('flex');
    setMobileMenuState(false);
});

document.getElementById('tab-settings-save-btn')?.addEventListener('click', () => {
    const checkboxes = Array.from(document.querySelectorAll('.tab-pref-checkbox'));
    const prefs = {};
    checkboxes.forEach((checkbox) => {
        prefs[checkbox.dataset.target] = checkbox.checked;
    });
    writeTabPrefsToLocal(prefs);
    writeTabPrefsToCloud(prefs);
    applyTabVisibilityPreferences();
    document.getElementById('tab-settings-popup')?.classList.add('hidden');
});

document.getElementById('open-profile-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    const searchKey = getCollectorKey();
    const myData = allStaff.find(s => normalizeEmail(s.email) === searchKey || String(s.loginId || '').toLowerCase() === searchKey || normalizeEmail(s.name) === searchKey);
    const staffAccess = window.AppSession?.getStaffAccess?.();

    if(myData) {
        document.getElementById('my-prof-name').textContent = myData.name || 'Staff';
        document.getElementById('my-prof-role').textContent = myData.role || myData.type || 'Staff';
        document.getElementById('my-prof-email').textContent = myData.email || '-';
        document.getElementById('my-prof-phone').textContent = myData.phone || '-';
        document.getElementById('my-prof-msr').textContent = myData.msr || '-';
        document.getElementById('my-prof-addr').textContent = myData.address || '-';
        document.getElementById('my-prof-img').src = myData.photo || "https://via.placeholder.com/150";
    } else if (staffAccess) {
        document.getElementById('my-prof-name').textContent = window.AppSession?.getStaffName?.() || 'Staff';
        document.getElementById('my-prof-role').textContent = staffAccess.role || staffAccess.type || 'Staff';
        document.getElementById('my-prof-email').textContent = window.AppSession?.getStaffEmail?.() || '-';
        document.getElementById('my-prof-phone').textContent = staffAccess.phone || '-';
        document.getElementById('my-prof-msr').textContent = '-';
        document.getElementById('my-prof-addr').textContent = '-';
        document.getElementById('my-prof-img').src = staffAccess.photo || "https://via.placeholder.com/150";
    } else if(isCurrentAdmin) {
        document.getElementById('my-prof-name').textContent = "Administrator";
        document.getElementById('my-prof-role').textContent = "Master Admin";
        document.getElementById('my-prof-email').textContent = currentUserEmail || 'admin@institute.com';
        document.getElementById('my-prof-phone').textContent = "-";
        document.getElementById('my-prof-msr').textContent = "-";
        document.getElementById('my-prof-addr').textContent = "System Administrator Account";
        document.getElementById('my-prof-img').src = "assets/images/logo.png";
    }
    document.getElementById('my-profile-popup').classList.remove('hidden');
    document.getElementById('my-profile-popup').classList.add('flex');

    // Close Mobile Menu if Open
    const navMenu = document.querySelector('.nav-menu');
    if(navMenu) navMenu.classList.remove('active');
});

document.getElementById('logout-btn')?.addEventListener('click', () => {
    signOut(auth).then(async () => {
        await window.AppSession?.clearAll({ purgeClientData: true });
        window.location.href = 'index.html';
    });
});

// --- HELPER FUNCTIONS ---
const getStudentById = (id) => students.find(s => s.id === id) || (allStudentsRaw || []).find(s => s.id === id);
window.getStudentById = getStudentById;

const getStaffName = (email, savedName) => {
    if (savedName && savedName !== email) return savedName;
    if (!email) return 'Admin';
    const st = allStaff.find(s => s.email === email);
    if (st && st.name) return st.name;
    if (email === currentUserEmail && isCurrentAdmin) return 'Administrator';
    return email;
};

const isSameCollectorRecord = (recordCollector = '') => {
    const myKey = getCollectorKey();
    const myEmail = getEffectiveStaffEmail();
    const rec = normalizeEmail(recordCollector);
    if (!rec) return false;
    return rec === myKey || (myEmail && rec === myEmail);
};

const isFeeItemMatch = (paymentItemKey = '', targetItem = {}) => {
    const pKey = String(paymentItemKey || '').trim().toLowerCase();
    const tKey = String(targetItem?.key || '').trim().toLowerCase();
    if (!pKey || !tKey) return false;
    if (pKey === tKey) return true;
    if ((targetItem?.type || 'month') === 'month') {
        const tName = normalizeFeeItemName(targetItem.name || '').toLowerCase();
        const shortMonth = tName.slice(0, 3);
        if (shortMonth && (pKey === shortMonth || pKey === tName || pKey === `month_${shortMonth}` || pKey === `month-${shortMonth}`)) {
            return true;
        }
    }
    return false;
};
window.isFeeItemMatch = isFeeItemMatch;

const resolveCanonicalFeeItem = (rawKeyOrMonth = '', academicYear = '') => {
    const raw = String(rawKeyOrMonth || '').trim().toLowerCase();
    if (!raw || !Array.isArray(feeItems) || feeItems.length === 0) return null;
    const yearToMatch = academicYear || selectedFeeAcademicYear || currentWorkingAcademicYear || '';

    // 1. Exact key match in target academic year
    const exactYearMatch = feeItems.find(i =>
        String(i.key || '').trim().toLowerCase() === raw &&
        (!yearToMatch || !i.academicYear || i.academicYear === yearToMatch)
    );
    if (exactYearMatch) return exactYearMatch;

    // 2. Exact key match across any year
    const exactAnyMatch = feeItems.find(i => String(i.key || '').trim().toLowerCase() === raw);
    if (exactAnyMatch) return exactAnyMatch;

    // 3. Month prefix match (e.g. 'apr' -> 'April (2025-26)')
    const monthPrefix = raw.replace(/^month[-_]/, '').slice(0, 3);
    if (monthPrefix.length === 3) {
        const monthMatch = feeItems.find(i => {
            if ((i.type || 'month') !== 'month') return false;
            if (yearToMatch && i.academicYear && i.academicYear !== yearToMatch) return false;
            const cleanName = normalizeFeeItemName(i.name || '').toLowerCase();
            const cleanKey = String(i.key || '').toLowerCase();
            return cleanName.startsWith(monthPrefix) || cleanKey.includes(monthPrefix);
        });
        if (monthMatch) return monthMatch;
    }
    return null;
};
window.resolveCanonicalFeeItem = resolveCanonicalFeeItem;
window.resolveCanonicalFeeItemKey = resolveCanonicalFeeItem;

const getVisiblePayments = () => {
    if(isCurrentAdmin) return allPayments;
    return allPayments.filter((payment) => {
        if (!isSameCollectorRecord(payment.collectedBy)) return false;
        if (!selectedDutyClasses.length) return true;
        const paymentClass = payment.classLabel || payment.studentClass || getStudentById(payment.studentId)?.class || '';
        return selectedDutyClasses.includes(paymentClass);
    });
};
const getVisibleDonations = () => isCurrentAdmin
    ? [...allDonations]
    : allDonations.filter((donation) => isSameCollectorRecord(donation.collectedBy));
const getAcademicYearFromDate = (dateObj = new Date()) => {
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    return month < 5 ? `${year - 1}-${year}` : `${year}-${year + 1}`;
};
const toAcademicYearDocId = (academicYear = '') => String(academicYear || '').trim().replace(/[^\w-]/g, '_');
const getYearPaymentsCollectionPath = (academicYear = '') => `${BASE_PATH}/academicYears/${toAcademicYearDocId(academicYear || getAcademicYearFromDate())}/payments`;
const queuePaymentWrite = (batch, payload) => {
    const paymentRef = doc(collection(db, `${BASE_PATH}/payments`));
    batch.set(paymentRef, payload);
    const yearPath = getYearPaymentsCollectionPath(payload.academicYear);
    batch.set(doc(db, yearPath, paymentRef.id), payload);
};
const compareAcademicYears = (a = '', b = '') => {
    const [aStart = 0] = String(a).split('-').map(Number);
    const [bStart = 0] = String(b).split('-').map(Number);
    return bStart - aStart;
};
const applyCurrentYearStudentScope = () => {
    if (!Array.isArray(allStudentsRaw)) {
        students = [];
        return;
    }
    const filterActiveOnly = (student) => {
        const cls = String(student.class || '').trim().toLowerCase();
        const st = String(student.status || '').trim().toLowerCase();
        return cls !== 'alumni' && st !== 'alumni' && st !== 'graduated' && st !== 'discontinued' && student.isAlumni !== true;
    };
    if (!currentWorkingAcademicYear) {
        students = allStudentsRaw.filter(filterActiveOnly);
        return;
    }
    students = allStudentsRaw.filter((student) => {
        const studentYear = student.academicYear || currentWorkingAcademicYear;
        return studentYear === currentWorkingAcademicYear && filterActiveOnly(student);
    });
};
const getPaymentGroupKey = (payment = {}) => {
    if (payment.transactionId) return `txn:${payment.transactionId}`;
    if (payment.receiptNo !== undefined && payment.receiptNo !== null && payment.receiptNo !== '') {
        return `rcpt:${payment.collectedBy || 'unknown'}:${payment.receiptNo}`;
    }
    return `fallback:${payment.studentId || 'unknown'}:${payment.itemKey || 'unknown'}:${payment.timestamp || payment.paymentDate || 'na'}`;
};
const parsePaymentGroupKey = (groupKey = '') => {
    if (groupKey.startsWith('txn:')) return { type: 'transaction', transactionId: groupKey.slice(4) };
    if (groupKey.startsWith('rcpt:')) {
        const payload = groupKey.slice(5);
        const splitIndex = payload.lastIndexOf(':');
        if (splitIndex === -1) return { type: 'unknown' };
        const collectedBy = payload.slice(0, splitIndex);
        const receiptNo = Number(payload.slice(splitIndex + 1));
        if (Number.isNaN(receiptNo)) return { type: 'unknown' };
        return { type: 'receipt', collectedBy, receiptNo };
    }
    return { type: 'fallback' };
};
const collectPaymentDocsForGroup = async (groupKey = '', expectedStudentId = '') => {
    const parsed = parsePaymentGroupKey(groupKey);
    if (parsed.type === 'transaction') {
        const txnSnap = await getDocs(query(collection(db, `${BASE_PATH}/payments`), where("transactionId", "==", parsed.transactionId)));
        return txnSnap.docs;
    }

    if (parsed.type === 'receipt') {
        const receiptSnap = await getDocs(query(collection(db, `${BASE_PATH}/payments`), where("receiptNo", "==", parsed.receiptNo)));
        return receiptSnap.docs.filter((docSnap) => {
            const data = docSnap.data();
            const sameCollector = (data.collectedBy || '') === parsed.collectedBy;
            if (!sameCollector) return false;
            if (!expectedStudentId) return true;
            return (data.studentId || '') === expectedStudentId;
        });
    }

    return [];
};

const downloadTextFile = (filename, content, mimeType = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

const buildMonthlyReportSummary = (payments) => {
    const summary = {
        totalAmount: 0,
        defaultAmount: 0,
        donationAmount: 0,
        otherAmount: 0,
        receipts: new Set(),
        students: new Set()
    };

    const seenBillingKeys = new Set();
    payments.forEach((payment) => {
        const itemType = getPaymentItemType(payment);
        const billingKey = getPaymentBillingKey(payment);
        const shouldCountAmount = !seenBillingKeys.has(billingKey);
        if (shouldCountAmount) seenBillingKeys.add(billingKey);
        const amount = shouldCountAmount ? getMonthlyReportPaymentAmount(payment) : 0;
        summary.totalAmount = roundMoney(summary.totalAmount + amount);
        if (itemType === 'donation') summary.donationAmount = roundMoney(summary.donationAmount + amount);
        else if (itemType === 'month') summary.defaultAmount = roundMoney(summary.defaultAmount + amount);
        else summary.otherAmount = roundMoney(summary.otherAmount + amount);
        summary.receipts.add(getPaymentGroupKey(payment));
        if (payment.studentId) summary.students.add(payment.studentId);
    });

    return summary;
};

const renderMonthlySummaryCards = (payments, searchTerm = '') => {
    const summary = buildMonthlyReportSummary(payments);
    const summaryContainer = document.getElementById('monthly-report-summary');
    const subtitle = searchTerm ? `Filtered by "${searchTerm}"` : 'All visible collections';

    summaryContainer.innerHTML = `
        <div class="insight-card success">
            <div class="insight-label">Default Fee</div>
            <div class="insight-value">${formatCurrency(summary.defaultAmount)}</div>
            <div class="insight-subvalue">Monthly collections</div>
        </div>
        <div class="insight-card warning">
            <div class="insight-label">Donation</div>
            <div class="insight-value">${formatCurrency(summary.donationAmount)}</div>
            <div class="insight-subvalue">All donation entries</div>
        </div>
        <div class="insight-card info">
            <div class="insight-label">Other Fees</div>
            <div class="insight-value">${formatCurrency(summary.otherAmount)}</div>
            <div class="insight-subvalue">Custom or additional items</div>
        </div>
        <div class="insight-card">
            <div class="insight-label">Total</div>
            <div class="insight-value">${formatCurrency(summary.totalAmount)}</div>
            <div class="insight-subvalue">${summary.students.size} students • ${summary.receipts.size} receipts • ${escapeHtml(subtitle)}</div>
        </div>
    `;
};

const exportMonthlySummaryCsv = (searchTerm = '') => {
    const lowerTerm = searchTerm.toLowerCase();
    const visiblePayments = [...getVisiblePayments(), ...getVisibleDonations()].filter((payment) => {
        if (!searchTerm) return true;
        if (payment.entryType === 'donation') {
            return (payment.donorName || '').toLowerCase().includes(lowerTerm)
                || (payment.description || '').toLowerCase().includes(lowerTerm)
                || (payment.receiptNo && payment.receiptNo.toString().includes(lowerTerm));
        }
        const student = getStudentById(payment.studentId);
        return Boolean(student) && (
            student.name.toLowerCase().includes(lowerTerm) ||
            (student.adm && student.adm.toLowerCase().includes(lowerTerm)) ||
            student.class.toLowerCase().includes(lowerTerm) ||
            (payment.receiptNo && payment.receiptNo.toString().includes(lowerTerm))
        );
    });

    if (visiblePayments.length === 0) {
        alert('No monthly report data available to export.');
        return;
    }

    const monthlyGroups = visiblePayments.reduce((acc, payment) => {
        if (!payment.paymentDate) return acc;
        const monthKey = payment.paymentDate.substring(0, 7);
        if (!acc[monthKey]) acc[monthKey] = [];
        acc[monthKey].push(payment);
        return acc;
    }, {});

    const rows = [['Month', 'Total Collected', 'Monthly Fees', 'Other Fees', 'Receipts', 'Students']];
    Object.keys(monthlyGroups).sort().reverse().forEach((monthKey) => {
        const summary = buildMonthlyReportSummary(monthlyGroups[monthKey]);
        rows.push([
            formatMonthLabel(monthKey),
            summary.totalAmount.toFixed(0),
            summary.defaultAmount.toFixed(0),
            summary.otherAmount.toFixed(0),
            summary.receipts.size.toString(),
            summary.students.size.toString()
        ]);
    });

    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const suffix = searchTerm ? `-${searchTerm.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
    downloadTextFile(`monthly-report-summary${suffix || ''}.csv`, csv, 'text/csv;charset=utf-8');
};

// --- DASHBOARD RENDER ---
const renderDashboardStudentClassTable = () => {
    const tableHost = document.getElementById('dash-students-class-table');
    if (!tableHost) return;

    const classNames = [...new Set([
        ...classes,
        ...students.map((student) => student.class).filter(Boolean)
    ])].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));

    const rows = classNames.map((className) => {
        const classStudents = students.filter((student) => student.class === className);
        const boys = classStudents.filter((student) => String(student.gender || '').toLowerCase().startsWith('male')).length;
        const girls = classStudents.filter((student) => String(student.gender || '').toLowerCase().startsWith('female')).length;
        return { className, boys, girls, total: classStudents.length };
    }).filter((row) => row.total > 0);

    const totals = rows.reduce((acc, row) => ({
        boys: acc.boys + row.boys,
        girls: acc.girls + row.girls,
        total: acc.total + row.total
    }), { boys: 0, girls: 0, total: 0 });

    if (!rows.length) {
        tableHost.innerHTML = '<div class="p-4 text-center text-xs font-semibold text-gray-400">No student data available.</div>';
        return;
    }

    tableHost.innerHTML = `
        <table class="w-full text-xs sm:text-sm text-left">
            <thead class="bg-gray-50 text-gray-500 uppercase tracking-wider text-[10px] sm:text-xs">
                <tr>
                    <th class="px-4 py-2 font-bold">Class</th>
                    <th class="px-4 py-2 font-bold text-right">Boys</th>
                    <th class="px-4 py-2 font-bold text-right">Girls</th>
                    <th class="px-4 py-2 font-bold text-right">Total</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((row) => `
                    <tr class="border-t border-gray-100 hover:bg-indigo-50/30">
                        <td class="px-4 py-2 font-semibold text-gray-800">${escapeHtml(row.className)}</td>
                        <td class="px-4 py-2 text-right text-blue-700 font-bold">${row.boys}</td>
                        <td class="px-4 py-2 text-right text-pink-700 font-bold">${row.girls}</td>
                        <td class="px-4 py-2 text-right text-gray-900 font-extrabold">${row.total}</td>
                    </tr>`).join('')}
            </tbody>
            <tfoot class="bg-indigo-50 border-t border-indigo-100">
                <tr>
                    <td class="px-4 py-2 font-extrabold text-indigo-900">Total</td>
                    <td class="px-4 py-2 text-right font-extrabold text-indigo-900">${totals.boys}</td>
                    <td class="px-4 py-2 text-right font-extrabold text-indigo-900">${totals.girls}</td>
                    <td class="px-4 py-2 text-right font-extrabold text-indigo-900">${totals.total}</td>
                </tr>
            </tfoot>
        </table>`;
};

const updateDashboardMetrics = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const currentMonthStr = todayStr.substring(0, 7);
    const myPays = [...getVisiblePayments(), ...getVisibleDonations()];

    let todayTotal = 0, monthTotal = 0;
    const todayReceipts = new Set();

    myPays.forEach(p => {
        const amt = parseFloat(p.amount) || 0;
        if(p.paymentDate === todayStr) {
            todayTotal += amt;
            todayReceipts.add(getPaymentGroupKey(p));
        }
        if(p.paymentDate && p.paymentDate.substring(0,7) === currentMonthStr) {
            monthTotal += amt;
        }
    });

    document.getElementById('dash-today-amt').textContent = todayTotal.toFixed(0);
    document.getElementById('dash-month-amt').textContent = monthTotal.toFixed(0);
    document.getElementById('dash-today-receipts').textContent = todayReceipts.size;
    document.getElementById('dash-students-count').textContent = students.length;
    renderDashboardStudentClassTable();
};

const getAvailableFeeYearsForStudent = (student) => {
    const fallbackYear = student?.academicYear || getAcademicYearFromDate();
    const configuredYears = academicYearSettings
        .filter((y) => y.status !== 'archived')
        .map((y) => y.label);
    const years = [...new Set(
        feeItems
            .map((item) => item.academicYear)
            .filter(Boolean)
            .concat(configuredYears)
            .concat([fallbackYear])
    )]
        .filter((year) => isYearVisibleInCollection(year))
        .sort(compareAcademicYears);
    return years;
};
const renderFeeYearSwitcher = () => {
    const switcher = document.getElementById('fee-year-switcher');
    const label = document.getElementById('fee-year-label');
    const prevBtn = document.getElementById('fee-year-prev-btn');
    const nextBtn = document.getElementById('fee-year-next-btn');
    const prevLabel = document.getElementById('fee-year-prev-label');
    const nextLabel = document.getElementById('fee-year-next-label');
    if (!switcher || !label || !prevBtn || !nextBtn || !prevLabel || !nextLabel) return;
    if (!selectedStudentId || availableFeeAcademicYears.length === 0) {
        switcher.classList.add('hidden');
        return;
    }
    switcher.classList.remove('hidden');
    const currentIndex = Math.max(0, availableFeeAcademicYears.indexOf(selectedFeeAcademicYear));
    label.textContent = `${selectedFeeAcademicYear}`;
    prevBtn.disabled = currentIndex >= availableFeeAcademicYears.length - 1;
    nextBtn.disabled = currentIndex <= 0;
    prevBtn.classList.toggle('opacity-40', prevBtn.disabled);
    nextBtn.classList.toggle('opacity-40', nextBtn.disabled);
    prevLabel.textContent = currentIndex < availableFeeAcademicYears.length - 1 ? availableFeeAcademicYears[currentIndex + 1] : '--';
    nextLabel.textContent = currentIndex > 0 ? availableFeeAcademicYears[currentIndex - 1] : '--';
};

const getClassOptionsForCollector = () => {
    if (isCurrentAdmin || !selectedDutyClasses.length) return classes;
    return classes.filter((cls) => selectedDutyClasses.includes(cls));
};

const renderMyClassTab = () => {
    const listEl = document.getElementById('my-class-list');
    if (!listEl) return;
    const classOptions = classes.length ? classes : [];
    listEl.innerHTML = classOptions.map((classLabel) => {
        const checked = selectedDutyClasses.includes(classLabel) ? 'checked' : '';
        return `<label class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold cursor-pointer hover:bg-blue-50 transition">
            <input type="checkbox" class="my-class-checkbox w-4 h-4 text-blue-600 rounded" value="${classLabel}" ${checked}>
            <span class="text-gray-800">${classLabel}</span>
        </label>`;
    }).join('') || '<div class="text-xs text-gray-500 p-3">No classes available.</div>';
};

const getStaffDirectoryRank = (staff = {}) => {
    const type = String(staff.type || '').trim().toLowerCase();
    if (type === 'teacher') return 1;
    if (type === 'management') return 2;
    return 3;
};
const buildStaffDirectoryCard = (staff = {}) => {
    const displayName = escapeHtml(staff.name || staff.email || 'Staff');
    const roleLabel = escapeHtml(staff.role || staff.type || 'Staff');
    const typeRank = getStaffDirectoryRank(staff);
    const badgeClass = typeRank === 1
        ? 'bg-blue-100 text-blue-800 border-blue-200'
        : typeRank === 2
            ? 'bg-purple-100 text-purple-800 border-purple-200'
            : 'bg-slate-100 text-slate-700 border-slate-200';
    const roleBadge = `<span class="${badgeClass} text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide border">${roleLabel}</span>`;
    const classLabel = Array.isArray(staff.dutyClasses) && staff.dutyClasses.length
        ? `<div class="flex flex-wrap gap-1 mt-1">${staff.dutyClasses.map(c => `<span class="bg-gray-100 text-gray-700 text-[10px] px-1.5 py-0.5 rounded border border-gray-200">${escapeHtml(c)}</span>`).join('')}</div>`
        : '<span class="text-[10px] text-gray-400 italic">Not assigned</span>';
    const emailLine = isCurrentAdmin ? `<div class="text-[10px] text-gray-400 mt-1 truncate" title="${escapeHtml(staff.email || '--')}"><i class="fas fa-envelope mr-1"></i>${escapeHtml(staff.email || '--')}</div>` : '';
    const photo = staff.photo || '';

    return `<div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:shadow-md transition relative flex gap-3">
        <div class="w-12 h-12 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 shadow-inner mt-0.5">
            ${photo ? `<img src="${photo}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-slate-400 text-lg"></i>`}
        </div>
        <div class="flex-1 min-w-0">
            <div class="flex justify-between items-start mb-1 gap-2">
                <div class="font-bold text-gray-800 text-sm truncate pr-2">${displayName}</div>
                ${roleBadge}
            </div>
            ${emailLine}
            <div class="mt-3 pt-3 border-t border-gray-50">
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Duty Classes</div>
                ${classLabel}
            </div>
        </div>
    </div>`;
};
const buildDirectoryCollectorCard = (entry = {}) => {
    const displayName = escapeHtml(getDirectoryValue(entry, ['name', 'fullName', 'title']) || 'Collector');
    const categoryName = escapeHtml(getDirectoryCategoryName(entry.categoryId));
    const roleLabel = escapeHtml(getDirectoryValue(entry, ['role', 'designation', 'type']) || categoryName);
    const phone = getDirectoryValue(entry, ['phone', 'mobile', 'contactPhone']);
    const phoneLine = phone ? `<div class="text-[10px] text-gray-500 mt-1 truncate"><i class="fas fa-phone mr-1"></i>${escapeHtml(phone)}</div>` : '';
    const photo = getDirectoryValue(entry, ['photo', 'image', 'logo', 'img']) || '';

    return `<div class="bg-white border border-emerald-200 rounded-xl p-4 shadow-sm hover:shadow-md transition relative flex gap-3">
        <div class="w-12 h-12 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 shadow-inner mt-0.5">
            ${photo ? `<img src="${photo}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-slate-400 text-lg"></i>`}
        </div>
        <div class="flex-1 min-w-0">
            <div class="flex justify-between items-start mb-1 gap-2">
                <div class="font-bold text-gray-800 text-sm truncate pr-2">${displayName}</div>
                <span class="bg-emerald-100 text-emerald-800 border border-emerald-200 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">${categoryName}</span>
            </div>
            <div class="text-xs text-gray-500 font-medium">${roleLabel}</div>
            ${phoneLine}
            <div class="mt-3 pt-3 border-t border-gray-50">
                <span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5">Collection Access</span>
            </div>
        </div>
    </div>`;
};
const renderStaffDirectory = () => {
    const host = document.getElementById('collection-staff-directory');
    if (!host) return;
    const visibleStaff = [...allStaff]
        .filter((staff) => staff && staff.isActive !== false && staff.canCollect !== false)
        .sort((a, b) => getStaffDirectoryRank(a) - getStaffDirectoryRank(b) || Number(a.displayOrder || 999) - Number(b.displayOrder || 999) || String(a.name || '').localeCompare(String(b.name || '')));
    const visibleDirectoryCollectors = [...directoryEntries]
        .filter((entry) => entry && entry.categoryId && entry.isActive !== false && getDirectoryCollectionAccess(entry))
        .sort((a, b) => getDirectoryCategoryName(a.categoryId).localeCompare(getDirectoryCategoryName(b.categoryId)) || Number(a.displayOrder || 999) - Number(b.displayOrder || 999) || getDirectoryValue(a, ['name', 'fullName', 'title']).localeCompare(getDirectoryValue(b, ['name', 'fullName', 'title'])));
    if (!visibleStaff.length && !visibleDirectoryCollectors.length) {
        host.innerHTML = '<div class="text-xs text-gray-500 bg-white border border-dashed rounded-lg p-3">No collection-access staff available.</div>';
        return;
    }
    host.innerHTML = [
        ...visibleStaff.map(buildStaffDirectoryCard),
        ...visibleDirectoryCollectors.map(buildDirectoryCollectorCard)
    ].join('');
};

// 🌟 FIX: Database Sync Logic Update
document.getElementById('save-my-class-btn')?.addEventListener('click', async () => {
    const selected = Array.from(document.querySelectorAll('.my-class-checkbox:checked')).map((checkbox) => checkbox.value);
    selectedDutyClasses = selected;
    collectorPaymentDetails = getDutyPaymentDetails();
    
    // Save to local storage for immediate UI reflect
    localStorage.setItem(getDutyStorageKey(), JSON.stringify(selectedDutyClasses));
    localStorage.setItem(getDutyPaymentStorageKey(), JSON.stringify(collectorPaymentDetails));
    
    const msg = document.getElementById('my-class-save-msg');
    
    if (isCurrentAdmin) {
        alert("Admin account cannot be assigned specific classes. Please log in as a staff member to take class duty.");
        return;
    }

    try {
        const btn = document.getElementById('save-my-class-btn');
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Saving...`;
        btn.disabled = true;

        // Find Exact Firestore Document ID for this Staff
        const searchKey = getCollectorKey(); // This could be email OR directory loginId
        const myStaffRecord = allStaff.find(s => normalizeEmail(s.email) === searchKey || String(s.loginId).toLowerCase() === searchKey);

        if (myStaffRecord?.id) {
            // Securely update the central database
            await updateDoc(doc(db, `${BASE_PATH}/staff`, myStaffRecord.id), {
                dutyClasses: selectedDutyClasses,
                dutyPaymentDetails: collectorPaymentDetails,
                updatedAt: new Date().toISOString()
            });
            
            if (msg) {
                msg.textContent = 'Details saved successfully!';
                msg.classList.remove('opacity-0');
                setTimeout(() => { msg.classList.add('opacity-0'); }, 3000);
            }
        } else {
            alert("Your staff profile was not found in the system. Please contact the administrator.");
        }
    } catch (error) {
        console.error('Failed to save My Class Duty details', error);
        alert('Failed to save details. Please check your internet connection.');
    } finally {
        const btn = document.getElementById('save-my-class-btn');
        btn.innerHTML = `<i class="fas fa-save mr-2"></i> Save Details`;
        btn.disabled = false;
        populateClassDropdowns();
        resetStudentSelection();
        renderFeeTable();
    }
});

['duty-pay-account-name', 'duty-pay-upi-number', 'duty-pay-upi-id']
    .forEach((inputId) => {
        document.getElementById(inputId)?.addEventListener('input', () => {
            collectorPaymentDetails = getDutyPaymentDetails();
        });
    });

const setupDonationEntryUI = () => {
    const today = new Date().toISOString().split('T')[0];
    const dateInput = document.getElementById('donation-date');
    if (dateInput && !dateInput.value) dateInput.value = today;
    const saveBtn = document.getElementById('save-donation-btn');
    if (saveBtn) saveBtn.textContent = editingDonationId ? 'Update Donation' : 'Save Donation';
};
document.getElementById('save-donation-btn')?.addEventListener('click', async () => {
    if (isDonationSaveInFlight) return;
    const donorName = document.getElementById('donation-name')?.value?.trim() || '';
    const receiptRaw = document.getElementById('donation-receipt')?.value?.trim() || '';
    const description = document.getElementById('donation-description')?.value?.trim() || '';
    const amount = Number(document.getElementById('donation-amount')?.value || 0);
    const donationDate = document.getElementById('donation-date')?.value || new Date().toISOString().split('T')[0];
    if (!donorName || !amount || amount <= 0) {
        alert('Donor name and valid amount are required.');
        return;
    }
    const receiptNo = receiptRaw ? parseInt(receiptRaw, 10) : null;
    if (receiptNo) {
        const hasDuplicate = allDonations.some((donation) => {
            if (editingDonationId && donation.id === editingDonationId) return false;
            return donation.collectedBy === getCollectorKey() && Number(donation.receiptNo) === receiptNo;
        });
        if (hasDuplicate) {
            alert(`Donation receipt ${receiptNo} is already used.`);
            return;
        }
    }
    const collectorLabel = isCurrentAdmin ? 'Administrator' : (allStaff.find((staff) => normalizeEmail(staff.email) === normalizeEmail(currentUserEmail))?.name || currentUserEmail);
    const donationDoc = {
        donorName,
        receiptNo,
        description,
        amount,
        paymentDate: donationDate,
        academicYear: getAcademicYearFromDate(new Date(donationDate)),
        timestamp: Date.now(),
        collectedBy: getCollectorKey(),
        collectedByName: collectorLabel,
        entryType: 'donation'
    };
    isDonationSaveInFlight = true;
    const donationBtn = document.getElementById('save-donation-btn');
    if (donationBtn) donationBtn.disabled = true;
    try {
        if (editingDonationId) {
            await updateDoc(doc(db, `${BASE_PATH}/donations`, editingDonationId), donationDoc);
        } else {
            await setDoc(doc(collection(db, `${BASE_PATH}/donations`)), donationDoc);
        }
        document.getElementById('donation-name').value = '';
        document.getElementById('donation-receipt').value = '';
        document.getElementById('donation-description').value = '';
        document.getElementById('donation-amount').value = '';
        editingDonationId = null;
        setupDonationEntryUI();
        const msg = document.getElementById('donation-save-msg');
        if (msg) {
            msg.textContent = 'Donation saved.';
            setTimeout(() => { msg.textContent = ''; }, 2000);
        }
    } catch (error) {
        console.error(error);
        alert('Failed to save donation.');
    } finally {
        isDonationSaveInFlight = false;
        if (donationBtn) donationBtn.disabled = false;
    }
});


const isMultiEntryMode = () => document.getElementById('multi-entry-toggle')?.checked === true;
const renderMultiEntryQueue = () => {
    const panel = document.getElementById('multi-entry-panel');
    const count = document.getElementById('multi-entry-count');
    const list = document.getElementById('multi-entry-list');
    if (!panel || !count || !list) return;
    panel.classList.toggle('hidden', !isMultiEntryMode());
    count.textContent = `${multiEntryQueue.length} students queued for same receipt`;
    list.innerHTML = multiEntryQueue.map((entry, index) => `
        <div class="flex items-center justify-between bg-white border border-blue-100 rounded-lg px-3 py-2 text-sm">
            <div><b>${escapeHtml(entry.studentName)}</b> <span class="text-slate-500">(${escapeHtml(entry.classLabel || '--')})</span><div class="text-xs text-slate-500">Items: ${entry.items.length} • ₹${Number(entry.total || 0).toFixed(0)}</div></div>
            <div class="flex gap-2">${entry.isGroupedClone ? '' : `<button type="button" class="text-blue-600 font-bold" data-multi-edit="${index}">Edit</button>`}<button type="button" class="text-red-600 font-bold" data-multi-remove="${index}">Remove</button></div>
        </div>
    `).join('') || '<div class="text-xs text-slate-500">No students added yet.</div>';
};

const buildSelectedItemsForCurrentStudent = () => {
    captureCurrentYearFeeSelections();
    return Object.entries(pendingFeeSelectionsByYear).flatMap(([year, selections]) =>
        Object.entries(selections || {})
            .filter(([, item]) => item?.checked)
            .map(([itemKey, item]) => ({ year, itemKey, itemType: item.type, amount: Number(item.amount || 0) }))
    );
};


const getStudentBillingGroup = (studentId = '') => studentGroups.find((g) => Array.isArray(g.memberIds) && g.memberIds.includes(studentId));

const roundMoney = (value = 0) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const getPaymentBillingKey = (payment = {}) => payment.billingGroupId && getPaymentItemType(payment) === 'month'
    ? `${getPaymentGroupKey(payment)}__${payment.itemKey || ''}__${payment.academicYear || ''}__${payment.billingGroupId}`
    : `${getPaymentGroupKey(payment)}__${payment.studentId || ''}__${payment.itemKey || ''}__${payment.academicYear || ''}`;
const getCurrentEffectiveMonthlyFee = () => {
    const st = getStudentById(selectedStudentId);
    if (!st) return defaultFee;
    const group = getStudentBillingGroup(st.id);
    if (!group || !Array.isArray(group.memberIds) || group.memberIds.length <= 1) {
        if (st.concessionFee !== undefined && st.concessionFee !== null && st.concessionFee !== "") {
            return parseFloat(st.concessionFee);
        }
        return defaultFee;
    }

    const selectedIds = selectedGroupMemberIds && selectedGroupMemberIds.size > 0
        ? [...selectedGroupMemberIds]
        : group.memberIds;

    // All members in group selected -> collective group fee
    if (selectedIds.length === group.memberIds.length) {
        return Number(group.fee > 0 ? group.fee : defaultFee);
    }

    // Only 1 member selected -> individual rate applies
    if (selectedIds.length === 1) {
        const member = getStudentById(selectedIds[0]);
        if (member && member.concessionFee !== undefined && member.concessionFee !== null && member.concessionFee !== "") {
            return parseFloat(member.concessionFee);
        }
        return defaultFee;
    }

    // Subset of members selected -> sum of individual rates
    let subsetSum = 0;
    selectedIds.forEach((id) => {
        const member = getStudentById(id);
        if (member && member.concessionFee !== undefined && member.concessionFee !== null && member.concessionFee !== "") {
            subsetSum += parseFloat(member.concessionFee);
        } else {
            subsetSum += defaultFee;
        }
    });
    return subsetSum;
};

const getMonthlyReportPaymentAmount = (payment = {}) => {
    if (getPaymentItemType(payment) !== 'month' || !payment.billingGroupId) return roundMoney(payment.amount || 0);
    if (payment.groupMonthAmount !== undefined && payment.groupMonthAmount !== null && Number(payment.groupMonthAmount) > 0) {
        return roundMoney(payment.groupMonthAmount);
    }
    const billingGroup = studentGroups.find((group) => group.id === payment.billingGroupId);
    const groupFee = Number(billingGroup?.fee || 0);
    return roundMoney(groupFee > 0 ? groupFee : payment.amount || 0);
};
const sumReportPaymentsOnce = (payments = [], predicate = () => true) => {
    const seenBillingKeys = new Set();
    return roundMoney(payments.reduce((sum, payment) => {
        if (!predicate(payment)) return sum;
        const billingKey = getPaymentBillingKey(payment);
        if (seenBillingKeys.has(billingKey)) return sum;
        seenBillingKeys.add(billingKey);
        return sum + getMonthlyReportPaymentAmount(payment);
    }, 0));
};

const getGroupMemberStudents = (group = {}) => (group.memberIds || []).map((id) => getStudentById(id)).filter(Boolean);

const renderGroupedStudentsPanel = () => {
    const panel = document.getElementById('grouped-students-panel');
    if (!panel) return;
    const group = selectedStudentId ? getStudentBillingGroup(selectedStudentId) : null;
    const members = group ? getGroupMemberStudents(group) : [];
    if (!group || members.length <= 1) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    if (!selectedGroupMemberIds || selectedGroupMemberIds.size === 0) {
        selectedGroupMemberIds = new Set(group.memberIds);
    }

    const effectiveBaseFee = getCurrentEffectiveMonthlyFee();
    const groupCollectiveFee = Number(group.fee > 0 ? group.fee : defaultFee);
    const isAllSelected = selectedGroupMemberIds.size === members.length;
    const isSingleSelected = selectedGroupMemberIds.size === 1;
    const singleStudent = isSingleSelected ? getStudentById([...selectedGroupMemberIds][0]) : null;

    const memberRows = members.map((student, index) => {
        const isChecked = selectedGroupMemberIds.has(student.id);
        const hasConcession = student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '';
        const indRate = hasConcession ? parseFloat(student.concessionFee) : defaultFee;
        const rateBadge = hasConcession
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Concession: ₹${indRate}</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">Normal: ₹${indRate}</span>`;

        return `
        <li class="flex items-center justify-between gap-2 rounded-xl bg-white border ${isChecked ? 'border-emerald-300 shadow-sm' : 'border-gray-200 opacity-60'} p-2.5 transition">
            <div class="flex items-center gap-2.5 min-w-0">
                <input type="checkbox" id="grp-stu-${student.id}" data-grp-student-id="${student.id}"
                       class="group-member-checkbox w-4 h-4 text-emerald-600 rounded border-gray-300 focus:ring-emerald-500 cursor-pointer"
                       ${isChecked ? 'checked' : ''}>
                <label for="grp-stu-${student.id}" class="cursor-pointer min-w-0">
                    <div class="font-bold text-gray-900 text-xs sm:text-sm truncate">${index + 1}. ${escapeHtml(student.name || 'Student')}</div>
                    <div class="text-[11px] text-gray-500 flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span class="font-semibold text-emerald-700">Class: ${escapeHtml(student.class || '--')}</span>
                        <span>•</span>
                        <span>Adm: ${escapeHtml(student.adm || '--')}</span>
                        <span>•</span>
                        ${rateBadge}
                    </div>
                </label>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
                <button type="button" data-grp-only-id="${student.id}"
                        class="group-member-only-btn text-xs font-bold px-2.5 py-1 rounded-lg border transition ${isChecked && isSingleSelected ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'}"
                        title="Collect fee only for this student">
                    <i class="fas fa-user-check text-[10px] mr-1"></i>Only
                </button>
            </div>
        </li>`;
    }).join('');

    let statusNote = '';
    if (isAllSelected) {
        statusNote = `<div class="text-[11px] font-medium text-emerald-800 bg-emerald-100/70 p-2 rounded-lg border border-emerald-200 flex items-center justify-between">
            <span><i class="fas fa-users mr-1"></i><b>All ${members.length} members selected</b> (Group rate: ₹${groupCollectiveFee}/month applied)</span>
            <span class="font-mono font-bold text-emerald-900">₹${groupCollectiveFee}/mo</span>
        </div>`;
    } else if (isSingleSelected && singleStudent) {
        statusNote = `<div class="text-[11px] font-medium text-blue-800 bg-blue-50 p-2 rounded-lg border border-blue-200">
            <div class="flex items-center justify-between">
                <span><i class="fas fa-user mr-1"></i><b>Only ${escapeHtml(singleStudent.name)} selected</b></span>
                <span class="font-mono font-bold text-blue-900">₹${effectiveBaseFee}/mo</span>
            </div>
            <p class="text-[10px] text-blue-600 mt-1">Individual rate applies. Unchecked siblings remain due without any balance carry-over.</p>
        </div>`;
    } else {
        statusNote = `<div class="text-[11px] font-medium text-amber-800 bg-amber-50 p-2 rounded-lg border border-amber-200 flex items-center justify-between">
            <span><i class="fas fa-user-friends mr-1"></i><b>${selectedGroupMemberIds.size} members selected</b></span>
            <span class="font-mono font-bold text-amber-900">₹${effectiveBaseFee}/mo</span>
        </div>`;
    }

    panel.innerHTML = `
        <div class="space-y-2.5">
            <div class="flex items-center justify-between gap-2 border-b border-emerald-200 pb-2">
                <div class="flex items-center gap-2">
                    <span class="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center text-xs"><i class="fas fa-users"></i></span>
                    <div>
                        <div class="font-extrabold text-emerald-900 text-xs sm:text-sm">Group / Sibling Fee Selection</div>
                        <div class="text-[10px] text-emerald-700 font-semibold">${selectedGroupMemberIds.size} of ${members.length} student(s) included</div>
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    <button type="button" id="grp-select-all-btn"
                            class="text-xs font-bold px-2.5 py-1 rounded-lg border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100 transition shadow-sm">
                        <i class="fas fa-check-double mr-1"></i>Select All
                    </button>
                </div>
            </div>
            <ol class="space-y-1.5">${memberRows}</ol>
            ${statusNote}
        </div>`;
    panel.classList.remove('hidden');
};

const onGroupMemberSelectionChanged = () => {
    const effectiveFee = getCurrentEffectiveMonthlyFee();
    captureCurrentYearFeeSelections();
    if (pendingFeeSelectionsByYear[selectedFeeAcademicYear]) {
        Object.entries(pendingFeeSelectionsByYear[selectedFeeAcademicYear]).forEach(([key, sel]) => {
            if (sel?.checked && sel.type === 'month') {
                sel.amount = effectiveFee;
                const monthInput = document.querySelector(`.month-fee-amount-input[data-item-key="${key}"]`);
                if (monthInput) monthInput.value = effectiveFee;
            }
        });
    }
    renderGroupedStudentsPanel();
    updateTotalAmount();
};

const setupGroupPanelListeners = () => {
    const panel = document.getElementById('grouped-students-panel');
    if (!panel || panel.dataset.listenersAttached === 'true') return;
    panel.dataset.listenersAttached = 'true';

    panel.addEventListener('click', (e) => {
        const onlyBtn = e.target.closest('[data-grp-only-id]');
        if (onlyBtn) {
            const stuId = onlyBtn.dataset.grpOnlyId;
            if (stuId) {
                selectedGroupMemberIds = new Set([stuId]);
                onGroupMemberSelectionChanged();
            }
            return;
        }

        const selectAllBtn = e.target.closest('#grp-select-all-btn');
        if (selectAllBtn) {
            const group = selectedStudentId ? getStudentBillingGroup(selectedStudentId) : null;
            if (group && Array.isArray(group.memberIds)) {
                selectedGroupMemberIds = new Set(group.memberIds);
                onGroupMemberSelectionChanged();
            }
            return;
        }
    });

    panel.addEventListener('change', (e) => {
        const cb = e.target.closest('.group-member-checkbox');
        if (cb) {
            const stuId = cb.dataset.grpStudentId;
            if (cb.checked) {
                selectedGroupMemberIds.add(stuId);
            } else {
                if (selectedGroupMemberIds.size <= 1) {
                    cb.checked = true;
                    showToast('At least one group member must be selected.', 'warning');
                    return;
                }
                selectedGroupMemberIds.delete(stuId);
            }
            onGroupMemberSelectionChanged();
        }
    });
};

const syncGroupedStudentsForSelectedStudent = () => {
    setupGroupPanelListeners();
    renderGroupedStudentsPanel();
};

const calculateEntryTotalForStudent = (entryItems = [], studentId = '') => {
    const baseFee = getCurrentEffectiveMonthlyFee();
    return entryItems.reduce((sum, item) => sum + Number(item.itemType === 'month' ? (item.amount !== undefined && item.amount !== null ? item.amount : baseFee) : (item.amount || 0)), 0);
};

const addCurrentStudentToMultiQueue = () => {
    if (!isMultiEntryMode()) return;
    if (!selectedStudentId) return alert('Please select a student.');
    const selected = buildSelectedItemsForCurrentStudent();
    if (!selected.length) return alert('Please select at least one fee item.');
    const st = getStudentById(selectedStudentId);
    const total = selected.reduce((sum, item) => sum + Number(item.itemType === 'month' ? getCurrentEffectiveMonthlyFee() : (item.amount || 0)), 0);
    multiEntryQueue.push({ studentId: selectedStudentId, studentName: st?.name || 'Student', classLabel: st?.class || '', items: selected, total });
    resetStudentSelection();
    document.getElementById('total-amount').value = 0;
    renderMultiEntryQueue();
};


const editMultiEntryItem = (index = -1) => {
    const entry = multiEntryQueue[index];
    if (!entry) return;
    const st = getStudentById(entry.studentId);
    if (!st) return;
    document.getElementById('entry-class').value = st.class || '';
    document.getElementById('entry-gender').value = st.gender || 'all';
    selectedStudentId = st.id;
    document.getElementById('entry-student-input').value = `${st.name} (Adm: ${st.adm || '-'})`;
    pendingFeeSelectionsByYear = {};
    (entry.items || []).forEach((item) => {
        const year = item.year || selectedFeeAcademicYear || '';
        if (!pendingFeeSelectionsByYear[year]) pendingFeeSelectionsByYear[year] = {};
        pendingFeeSelectionsByYear[year][item.itemKey] = { checked: true, type: item.itemType, amount: Number(item.amount || 0) };
    });
    multiEntryQueue.splice(index, 1);
    populateFeeItemSelection();
    updateTotalAmount();
    renderMultiEntryQueue();
};

// --- FEE ENTRY & LOGIC ---
const populateClassDropdowns = () => {
    classes = [...new Set(students.map(s => s.class).filter(Boolean))].sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    const classOptions = getClassOptionsForCollector();
    const opts = classOptions.map(c => `<option value="${c}">${c}</option>`).join('');
    const allClassOpts = classes.map(c => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('filter-class').innerHTML = `<option value="all">All Classes</option>` + opts;
    document.getElementById('entry-class').innerHTML = `<option value="">All Classes (Whole School)</option>` + opts;
    if (userExplicitClass) {
        document.getElementById('entry-class').value = userExplicitClass;
    }
    document.getElementById('stu-info-class').innerHTML = `<option value="">-- Select --</option>` + allClassOpts;
    
    // Also populate bulk upload class dropdown
    const bulkClassDropdown = document.getElementById('bulk-class');
    if (bulkClassDropdown) {
        bulkClassDropdown.innerHTML = `<option value="">-- Select Class --</option>` + allClassOpts;
    }

    renderMyClassTab();
    populateFeeStatusAcademicYears();
};

const updateStudentInputClearButton = () => {
    const input = document.getElementById('entry-student-input');
    const clearBtn = document.getElementById('entry-student-clear-btn');
    if (!input || !clearBtn) return;
    clearBtn.classList.toggle('hidden', !input.value.trim());
};
const resetStudentSelection = () => {
    selectedStudentId = null;
    selectedGroupMemberIds = new Set();
    pendingFeeSelectionsByYear = {};
    const input = document.getElementById('entry-student-input');
    if (input) input.value = '';
    document.getElementById('student-suggestions')?.classList.add('hidden');
    document.getElementById('grouped-students-panel')?.classList.add('hidden');

    // Restore top Class and Gender filters to user's deliberate selection (or 'All' if none selected)
    const classEl = document.getElementById('entry-class');
    if (classEl) classEl.value = userExplicitClass || '';
    const genderEl = document.getElementById('entry-gender');
    if (genderEl) genderEl.value = userExplicitGender || '';

    updateStudentInputClearButton();
    populateFeeItemSelection();
};
document.getElementById('entry-class').addEventListener('change', (e) => {
    userExplicitClass = e.target.value;
    const currentInputVal = document.getElementById('entry-student-input')?.value || '';
    if (selectedStudentId) {
        const currentStudent = getStudentById(selectedStudentId);
        if (userExplicitClass && currentStudent && currentStudent.class !== userExplicitClass) {
            resetStudentSelection();
        }
    }
    if (currentInputVal) {
        populateStudentSuggestions(currentInputVal);
    }
});
document.getElementById('entry-gender').addEventListener('change', (e) => {
    userExplicitGender = e.target.value;
    const currentInputVal = document.getElementById('entry-student-input')?.value || '';
    if (selectedStudentId) {
        const currentStudent = getStudentById(selectedStudentId);
        if (userExplicitGender && currentStudent && currentStudent.gender !== userExplicitGender) {
            resetStudentSelection();
        }
    }
    if (currentInputVal) {
        populateStudentSuggestions(currentInputVal);
    }
});
let feeStatusRowLimit = 25;
let feeStatusPageOffset = 0;

document.getElementById('filter-academic-year')?.addEventListener('change', () => {
    feeStatusPageOffset = 0;
    renderFeeTable();
});
document.getElementById('filter-class').addEventListener('change', () => {
    feeStatusPageOffset = 0;
    renderFeeTable();
});
document.getElementById('filter-gender').addEventListener('change', () => {
    feeStatusPageOffset = 0;
    renderFeeTable();
});
document.getElementById('fee-status-row-limit')?.addEventListener('change', (e) => {
    feeStatusRowLimit = parseInt(e.target.value, 10) || 25;
    feeStatusPageOffset = 0;
    renderFeeTable();
});

const populateStudentSuggestions = (searchTerm = '') => {
    const cls = document.getElementById('entry-class').value;
    const gen = document.getElementById('entry-gender').value;
    const lSugg = document.getElementById('student-suggestions');
    if (!lSugg) return;

    const lowerTerm = (searchTerm || '').trim().toLowerCase();
    const studentPool = Array.isArray(students) && students.length > 0 ? students : (Array.isArray(allStudentsRaw) ? allStudentsRaw : []);

    const fil = studentPool.filter(s => {
        const classMatch = !cls || cls === 'all' || s.class === cls;
        const genderMatch = !gen || gen === 'all' || s.gender === gen;
        if (!classMatch || !genderMatch) return false;
        if (!lowerTerm) return true;
        const nameMatch = (s.name || '').toLowerCase().includes(lowerTerm);
        const admMatch = (s.adm || '').toLowerCase().includes(lowerTerm);
        const rollMatch = (s.rollNo || s.roll || '').toString().toLowerCase().includes(lowerTerm);
        const phoneMatch = (s.phone || '').toLowerCase().includes(lowerTerm);
        return nameMatch || admMatch || rollMatch || phoneMatch;
    }).slice(0, 40);

    fil.sort((a,b) => (a.name || '').localeCompare(b.name || ''));
    lSugg.innerHTML = '';

    if (fil.length > 0) {
        fil.forEach(s => {
            const d = document.createElement('div');
            d.className = 'p-3 hover:bg-blue-50/80 cursor-pointer border-b border-slate-100 flex items-center justify-between gap-3 text-sm transition';
            d.innerHTML = `
                <div class="min-w-0 flex-1">
                    <div class="font-bold text-slate-900 text-sm flex items-center gap-2 flex-wrap">
                        <span>${escapeHtml(s.name)}</span>
                        <span class="px-1.5 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-100 text-blue-800 border border-blue-200">Class: ${escapeHtml(s.class || '-')}</span>
                        ${s.gender ? `<span class="text-[10px] font-bold text-slate-500">(${escapeHtml(s.gender.charAt(0))})</span>` : ''}
                        ${String(s.status || '').toLowerCase() === 'discontinued' ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-rose-100 text-rose-800 border border-rose-200">Discontinued</span>` : ''}
                    </div>
                    <div class="text-xs text-slate-500 font-mono mt-0.5 flex items-center gap-2">
                        <span>Adm: <b class="text-slate-700">${escapeHtml(s.adm || '-')}</b></span>
                        ${s.guardian ? `<span class="text-slate-400 truncate">• Guardian: ${escapeHtml(s.guardian)}</span>` : ''}
                    </div>
                </div>
                <i class="fas fa-chevron-right text-xs text-slate-300 flex-shrink-0"></i>
            `;
            d.onclick = () => {
                selectedStudentId = s.id;
                // Preserve top dropdowns as selected by user:
                // If user did not select Class at top, keep it on All Classes ('').
                // If user selected Class at top, keep user's selection.
                const classSelect = document.getElementById('entry-class');
                if (classSelect) {
                    classSelect.value = userExplicitClass || '';
                }
                // If user did not select Gender at top, keep it on All Genders ('').
                // If user selected Gender at top, keep user's selection.
                const genderSelect = document.getElementById('entry-gender');
                if (genderSelect) {
                    genderSelect.value = userExplicitGender || '';
                }
                const grp = getStudentBillingGroup(s.id);
                if (grp && Array.isArray(grp.memberIds) && grp.memberIds.length > 1) {
                    selectedGroupMemberIds = new Set(grp.memberIds);
                } else {
                    selectedGroupMemberIds = new Set([s.id]);
                }
                document.getElementById('entry-student-input').value = `${s.name} (Adm: ${s.adm||'-'}, Class: ${s.class||'-'})`;
                lSugg.classList.add('hidden');
                updateStudentInputClearButton();
                populateFeeItemSelection();
                syncGroupedStudentsForSelectedStudent();
            };
            lSugg.appendChild(d);
        });
        lSugg.classList.remove('hidden');
    } else {
        if (lowerTerm) {
            lSugg.innerHTML = `<div class="p-3 text-center text-xs font-semibold text-slate-500">No students found matching "${escapeHtml(lowerTerm)}"</div>`;
            lSugg.classList.remove('hidden');
        } else {
            lSugg.classList.add('hidden');
        }
    }
};
document.getElementById('entry-student-input').addEventListener('focus', () => populateStudentSuggestions(''));
document.getElementById('entry-student-input').addEventListener('input', e => {
    if (!e.target.value.trim() && selectedStudentId) {
        resetStudentSelection();
    }
    populateStudentSuggestions(e.target.value);
    updateStudentInputClearButton();
});
document.getElementById('entry-student-clear-btn')?.addEventListener('click', () => {
    resetStudentSelection();
    document.getElementById('entry-student-input')?.focus();
});
document.addEventListener('click', e => { if(!document.getElementById('student-combobox-container').contains(e.target)) document.getElementById('student-suggestions').classList.add('hidden'); });

document.getElementById('multi-entry-toggle')?.addEventListener('change', () => { if (!isMultiEntryMode()) multiEntryQueue = []; renderMultiEntryQueue(); });
document.getElementById('add-multi-student-btn')?.addEventListener('click', addCurrentStudentToMultiQueue);
document.getElementById('clear-multi-students-btn')?.addEventListener('click', () => { multiEntryQueue = []; renderMultiEntryQueue(); });
document.getElementById('multi-entry-list')?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-multi-edit]');
    if (editBtn) {
        const idx = Number(editBtn.dataset.multiEdit);
        if (!Number.isNaN(idx) && !multiEntryQueue[idx]?.isGroupedClone) editMultiEntryItem(idx);
        return;
    }
    const btn = e.target.closest('[data-multi-remove]');
    if (!btn) return;
    const idx = Number(btn.dataset.multiRemove);
    if (Number.isNaN(idx)) return;
    multiEntryQueue.splice(idx, 1);
    renderMultiEntryQueue();
});


const getNextReceiptNoForStaff = () => {
    const myPays = allPayments.filter(p => p.collectedBy === getCollectorKey() && p.receiptNo);
    if (myPays.length > 0) {
        const validPays = myPays.map(p => parseInt(p.receiptNo, 10)).filter(n => !isNaN(n) && n > 0);
        if (validPays.length > 0) return Math.max(...validPays) + 1;
    }
    const allValid = allPayments.map(p => parseInt(p.receiptNo, 10)).filter(n => !isNaN(n) && n > 0);
    if (allValid.length > 0) return Math.max(...allValid) + 1;
    return 1;
};

const checkReceiptMandatory = () => {
    let isReq = false;
    let anyChecked = false;
    document.querySelectorAll('.fee-item-checkbox:checked').forEach(cb => {
        anyChecked = true;
        const type = cb.dataset.itemType, key = cb.dataset.itemKey;
        if(type === 'custom') { 
            const item = feeItems.find(i=>i.key === key); 
            if(item && typeof item.isReceiptMandatory === 'boolean') {
                if (item.isReceiptMandatory) isReq = true;
            } else if (defaultReceiptMandatory) {
                isReq = true;
            }
        }
        else if(type === 'month') { 
            if(defaultReceiptMandatory) isReq = true; 
        }
    });
    if (!anyChecked && defaultReceiptMandatory) {
        isReq = true;
    }
    const star = document.getElementById('receipt-req-star');
    if (star) star.classList.toggle('hidden', !isReq);
    return isReq;
};
const captureCurrentYearFeeSelections = () => {
    if (!selectedFeeAcademicYear) return;
    const yearSelections = {};
    document.querySelectorAll('.fee-item-checkbox:not(:disabled)').forEach((cb) => {
        const card = cb.closest('.fee-month-item-card') || cb.closest('.relative');
        const isMonth = (cb.dataset.itemType || 'month') === 'month';
        let itemAmount = 0;
        if (isMonth) {
            const monthInput = card?.querySelector('.month-fee-amount-input');
            const parsedVal = parseFloat(monthInput?.value);
            itemAmount = Number.isFinite(parsedVal) && parsedVal >= 0 ? parsedVal : getCurrentEffectiveMonthlyFee();
        } else {
            const customInput = card?.querySelector('.custom-fee-amount-input');
            itemAmount = Number(customInput?.value || 0);
        }

        yearSelections[cb.dataset.itemKey] = {
            checked: cb.checked,
            type: cb.dataset.itemType || 'month',
            amount: Math.max(0, itemAmount)
        };
    });
    pendingFeeSelectionsByYear[selectedFeeAcademicYear] = yearSelections;
};

const updateTotalAmount = () => {
    let total = 0;
    captureCurrentYearFeeSelections();
    Object.values(pendingFeeSelectionsByYear).forEach((yearSelections = {}) => {
        Object.values(yearSelections).forEach((selection) => {
            if (!selection?.checked) return;
            total += Number(selection.amount || 0);
        });
    });
    document.getElementById('total-amount').value = roundMoney(total);
    renderGroupedStudentsPanel();
    checkReceiptMandatory();
};

const populateFeeItemSelection = () => {
    const st = getStudentById(selectedStudentId);
    const container = document.getElementById('fee-item-selection-container');

    if(!st) {
        container.innerHTML = '<div class="col-span-3 text-center text-xs font-semibold text-gray-400 py-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">Search and select a student first</div>';
        document.getElementById('total-amount').value = 0;
        const dueNotice = document.getElementById('fee-due-notice');
        if (dueNotice) {
            dueNotice.textContent = '';
            dueNotice.classList.add('hidden');
        }
        availableFeeAcademicYears = [];
        selectedFeeAcademicYear = '';
        renderFeeYearSwitcher();
        return;
    }

    availableFeeAcademicYears = getAvailableFeeYearsForStudent(st);
    if (!selectedFeeAcademicYear || !availableFeeAcademicYears.includes(selectedFeeAcademicYear)) {
        if (currentWorkingAcademicYear && availableFeeAcademicYears.includes(currentWorkingAcademicYear)) {
            selectedFeeAcademicYear = currentWorkingAcademicYear;
        } else {
            selectedFeeAcademicYear = st.academicYear && availableFeeAcademicYears.includes(st.academicYear)
                ? st.academicYear
                : availableFeeAcademicYears[0];
        }
    }
    renderFeeYearSwitcher();

    const visibleItems = feeItems.filter(i => {
        const itemYear = i.academicYear || getAcademicYearFromDate();
        if (selectedFeeAcademicYear && itemYear !== selectedFeeAcademicYear) return false;
        if(i.isVisible === false) return false;
        if(i.type === 'custom' && st) {
            if(i.scope === 'specific' && i.targetClass !== st.class) return false;
        }
        return true;
    });
    if (!visibleItems.some((item) => item.key === STUDENT_DONATION_ITEM_KEY)) {
        visibleItems.push({ ...STUDENT_DONATION_ITEM, academicYear: selectedFeeAcademicYear || getAcademicYearFromDate() });
    }

    if (visibleItems.length === 0) {
         container.innerHTML = '<div class="col-span-3 text-center text-xs font-semibold text-gray-400 py-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">No fee items available</div>';
         document.getElementById('total-amount').value = 0;
         return;
    }

    const renderFeeOption = (item) => {
        let defaultAmt = '';
        let amountLocked = false;
        if(item.type === 'custom' && st) {
            if(item.scope === 'global') defaultAmt = item.amount || '';
            else if(item.scope === 'class-wise' && item.classValues) defaultAmt = item.classValues[st.class] || '';
            else if(item.scope === 'specific') defaultAmt = item.amount || '';
            amountLocked = defaultAmt !== '' && defaultAmt !== null && defaultAmt !== undefined;
        }

        const itemYear = item.academicYear || '--';
        const displayName = normalizeFeeItemName(item.name || 'Fee Item');
        const isMonth = (item.type || 'month') === 'month';
        return `
        <div class="relative fee-month-item-card" data-item-key="${item.key}">
            <input type="checkbox" id="item-${item.key}" data-item-key="${item.key}" data-item-type="${item.type||'month'}" class="fee-item-checkbox peer sr-only">
            <label for="item-${item.key}" class="block py-2 px-1 text-[11px] sm:text-xs font-semibold border-2 border-red-300 text-red-700 rounded-lg cursor-pointer text-center bg-red-50 peer-checked:bg-green-600 peer-checked:text-white peer-checked:border-green-600 shadow-sm transition fee-item-label" title="${item.name}">
                <div class="leading-tight">
                    <div class="font-bold break-words">${displayName}</div>
                    <div class="text-[10px] opacity-80 mt-1 block">${itemYear}</div>
                    <div class="fee-item-receipt text-[10px] opacity-70 mt-1 h-3"></div>
                </div>
            </label>
            ${isMonth ? `
            <div class="month-amount-wrapper hidden mt-1.5">
                <div class="relative">
                    <span class="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-bold text-green-700">₹</span>
                    <input type="number" step="any" min="0" data-item-key="${item.key}"
                           class="month-fee-amount-input w-full p-1 pl-5 text-xs font-bold border border-green-300 rounded-md shadow-sm text-center bg-white text-green-900 focus:ring-1 focus:ring-green-500 focus:outline-none"
                           placeholder="Amount">
                </div>
            </div>` : `
            <input type="number" data-locked="${amountLocked ? 'true' : 'false'}" ${amountLocked ? 'readonly' : ''} class="custom-fee-amount-input hidden w-full mt-1.5 p-1.5 text-xs font-medium border rounded-md shadow-sm text-center ${amountLocked ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-gray-50'}" placeholder="₹ Amount" value="${defaultAmt}">
            `}
        </div>`;
    };
    const monthlyItems = sortMonthlyItemsByAcademicYear(
        visibleItems.filter((item) => (item.type || 'month') === 'month'),
        selectedFeeAcademicYear
    );
    const donationItems = visibleItems.filter((item) => item.key === STUDENT_DONATION_ITEM_KEY);
    const otherItems = visibleItems.filter((item) => (item.type || 'month') === 'custom' && item.key !== STUDENT_DONATION_ITEM_KEY);
    const buildSection = (title, items, tone = 'text-gray-500') => {
        if (!items.length) return '';
        return `<div class="col-span-3 mt-2"><div class="text-[10px] uppercase tracking-widest font-bold ${tone} mb-2">${title}</div><div class="grid grid-cols-3 gap-2">${items.map(renderFeeOption).join('')}</div></div>`;
    };
    container.innerHTML = [
        buildSection('Monthly Fees', monthlyItems, 'text-blue-600'),
        buildSection('Other Fees', otherItems, 'text-amber-600'),
        buildSection('Donation (Optional)', donationItems, 'text-emerald-600')
    ].join('');

    if(st) {
        document.querySelectorAll('.fee-item-checkbox').forEach(cb => {
            const isDonationItem = cb.dataset.itemKey === STUDENT_DONATION_ITEM_KEY;
            const currentItemObj = visibleItems.find(i => i.key === cb.dataset.itemKey);
            const pay = allPayments.find((payment) => {
                if (payment.studentId !== st.id) return false;
                const matchesItem = payment.itemKey === cb.dataset.itemKey || isFeeItemMatch(payment.itemKey, currentItemObj || { key: cb.dataset.itemKey, type: cb.dataset.itemType, name: cb.dataset.itemKey });
                if (!matchesItem) return false;
                return (payment.academicYear || '') === (selectedFeeAcademicYear || '');
            });
            const donationCount = isDonationItem
                ? allPayments.filter((payment) => payment.studentId === st.id && payment.itemKey === STUDENT_DONATION_ITEM_KEY && (payment.academicYear || '') === (selectedFeeAcademicYear || '')).length
                : 0;
            cb.checked = false; cb.disabled = isDonationItem ? false : !!pay;
            const receiptEl = cb.nextElementSibling.querySelector('.fee-item-receipt');
            if (receiptEl) receiptEl.textContent = isDonationItem ? (donationCount ? `${donationCount} donation(s)` : '') : (pay?.receiptNo ? `Rcpt: ${pay.receiptNo}` : '');
            
            // Clear custom colors
            const labelEl = cb.nextElementSibling;
            labelEl.classList.remove('fee-item-paid-elsewhere', 'fee-item-editing-yellow', 'fee-item-new-green');

            if(pay && !isDonationItem) { 
                labelEl.classList.add('fee-item-paid-elsewhere');
                cb.checked = true; 
            }
            const pending = pendingFeeSelectionsByYear[selectedFeeAcademicYear]?.[cb.dataset.itemKey];
            if (!cb.disabled && pending?.checked) {
                cb.checked = true;
                if (cb.dataset.itemType === 'custom') {
                    const customInput = cb.closest('.fee-month-item-card')?.querySelector('.custom-fee-amount-input');
                    if (customInput) {
                        customInput.classList.remove('hidden');
                        if (Number.isFinite(Number(pending.amount))) customInput.value = pending.amount;
                    }
                } else {
                    const monthWrap = cb.closest('.fee-month-item-card')?.querySelector('.month-amount-wrapper');
                    const monthInput = cb.closest('.fee-month-item-card')?.querySelector('.month-fee-amount-input');
                    if (monthWrap) monthWrap.classList.remove('hidden');
                    if (monthInput) monthInput.value = Number.isFinite(Number(pending.amount)) ? pending.amount : getCurrentEffectiveMonthlyFee();
                }
            }
        });
    }
    const dueNotice = document.getElementById('fee-due-notice');
    if (dueNotice) {
        dueNotice.textContent = '';
        dueNotice.classList.add('hidden');
    }
    updateTotalAmount();
};

document.getElementById('fee-item-selection-container').addEventListener('input', e => {
    if(e.target.classList.contains('custom-fee-amount-input') || e.target.classList.contains('month-fee-amount-input')) {
        updateTotalAmount();
    }
});
document.getElementById('fee-item-selection-container').addEventListener('change', e => {
    if (e.target.classList.contains('fee-item-checkbox')) {
        const cb = e.target;
        const card = cb.closest('.fee-month-item-card');
        const itemType = cb.dataset.itemType || 'month';

        if (isEditMode) {
            const itemKey = cb.dataset.itemKey;
            if (itemKey) editTouchedItemKeys.add(itemKey);
            const labelEl = cb.nextElementSibling;
            labelEl.classList.remove('fee-item-editing-yellow', 'fee-item-new-green');
            if (cb.checked) {
                labelEl.classList.add('fee-item-new-green');
            }
        }

        if(itemType === 'custom') {
            const input = card?.querySelector('.custom-fee-amount-input');
            if(input) {
                const isLocked = input.dataset.locked === 'true';
                input.classList.toggle('hidden', !cb.checked);
                if(!cb.checked && !isLocked) input.value = '';
            }
        } else {
            const monthWrap = card?.querySelector('.month-amount-wrapper');
            const monthInput = card?.querySelector('.month-fee-amount-input');
            if (monthWrap) monthWrap.classList.toggle('hidden', !cb.checked);
            if (monthInput) {
                if (cb.checked) {
                    if (!monthInput.value || Number(monthInput.value) === 0) {
                        monthInput.value = getCurrentEffectiveMonthlyFee();
                    }
                } else {
                    monthInput.value = '';
                }
            }
        }
        updateTotalAmount();
    }
});

const totalAmountInput = document.getElementById('total-amount');
if (totalAmountInput && totalAmountInput.dataset.listenerAttached !== 'true') {
    totalAmountInput.dataset.listenerAttached = 'true';
    totalAmountInput.addEventListener('input', (e) => {
        const rawTotal = parseFloat(e.target.value);
        const desiredTotal = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : 0;

        const activeMonthInputs = Array.from(document.querySelectorAll('.fee-item-checkbox:checked'))
            .filter(cb => (cb.dataset.itemType || 'month') === 'month' && !cb.disabled)
            .map(cb => cb.closest('.fee-month-item-card')?.querySelector('.month-fee-amount-input'))
            .filter(Boolean);

        let customTotal = 0;
        document.querySelectorAll('.fee-item-checkbox:checked').forEach(cb => {
            if (cb.dataset.itemType === 'custom' && !cb.disabled) {
                const card = cb.closest('.fee-month-item-card');
                const cInput = card?.querySelector('.custom-fee-amount-input');
                customTotal += Number(cInput?.value || 0);
            }
        });

        if (activeMonthInputs.length > 0) {
            const remainingForMonths = Math.max(0, desiredTotal - customTotal);
            const perMonth = roundMoney(remainingForMonths / activeMonthInputs.length);
            activeMonthInputs.forEach((input, index) => {
                const isLast = index === activeMonthInputs.length - 1;
                const monthAmt = isLast 
                    ? roundMoney(remainingForMonths - (perMonth * (activeMonthInputs.length - 1)))
                    : perMonth;
                input.value = Math.max(0, monthAmt);
            });
            captureCurrentYearFeeSelections();
            renderGroupedStudentsPanel();
            checkReceiptMandatory();
        }
    });
}
document.getElementById('fee-year-prev-btn')?.addEventListener('click', () => {
    if (!selectedStudentId) return;
    captureCurrentYearFeeSelections();
    const index = availableFeeAcademicYears.indexOf(selectedFeeAcademicYear);
    if (index < 0 || index >= availableFeeAcademicYears.length - 1) return;
    selectedFeeAcademicYear = availableFeeAcademicYears[index + 1];
    populateFeeItemSelection();
});
document.getElementById('fee-year-next-btn')?.addEventListener('click', () => {
    if (!selectedStudentId) return;
    captureCurrentYearFeeSelections();
    const index = availableFeeAcademicYears.indexOf(selectedFeeAcademicYear);
    if (index <= 0) return;
    selectedFeeAcademicYear = availableFeeAcademicYears[index - 1];
    populateFeeItemSelection();
});
const setupFeeEntryUI = () => {
    document.getElementById('fee-entry-title').textContent = "Fee Entry";
    document.getElementById('save-fee-btn').classList.remove('hidden'); document.getElementById('cancel-edit-btn').classList.add('hidden'); document.getElementById('update-fee-btn').classList.add('hidden');

    document.getElementById('entry-receipt').value = getNextReceiptNoForStaff();
    document.getElementById('entry-description').value = '';
    document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];
    const entryPayModeEl = document.getElementById('entry-payment-mode');
    if (entryPayModeEl) entryPayModeEl.value = 'Cash';
    populateFeeItemSelection();
    multiEntryQueue = [];
    renderMultiEntryQueue();
};

const exitEditMode = () => { isEditMode = false; editingPaymentGroup = {}; editTouchedItemKeys = new Set(); resetStudentSelection(); setupFeeEntryUI(); };
document.getElementById('cancel-edit-btn').addEventListener('click', exitEditMode);

const startEditingPayment = (studentId, txnId) => {
    const student = getStudentById(studentId); if(!student) return;
    document.querySelector('.nav-link[data-target="home-page"]').click();
    document.getElementById('entry-class').value = student.class || ''; document.getElementById('entry-gender').value = student.gender || 'all';
    selectedStudentId = student.id; document.getElementById('entry-student-input').value = `${student.name} (Adm: ${student.adm||'-'})`; document.getElementById('student-suggestions').classList.add('hidden');

    isEditMode = true;
    editTouchedItemKeys = new Set();
    document.getElementById('fee-entry-title').textContent = "Edit Payment";
    document.getElementById('save-fee-btn').classList.add('hidden'); document.getElementById('cancel-edit-btn').classList.remove('hidden'); document.getElementById('update-fee-btn').classList.remove('hidden');

    populateFeeItemSelection();

    const parsedKey = parsePaymentGroupKey(txnId);
    const grp = allPayments.filter((payment) => {
        if (parsedKey.type === 'transaction') return payment.transactionId === parsedKey.transactionId;
        if (parsedKey.type === 'receipt') return Number(payment.receiptNo) === parsedKey.receiptNo && (payment.collectedBy || '') === parsedKey.collectedBy;
        return false;
    });
    if(grp.length === 0) return;
    pendingFeeSelectionsByYear = {};
    grp.forEach((payment) => {
        const paymentYear = payment.academicYear || selectedFeeAcademicYear || '';
        if (!pendingFeeSelectionsByYear[paymentYear]) pendingFeeSelectionsByYear[paymentYear] = {};
        const feeItem = feeItems.find((item) => item.key === payment.itemKey);
        pendingFeeSelectionsByYear[paymentYear][payment.itemKey] = {
            checked: true,
            type: feeItem?.type || 'custom',
            amount: Number(payment.amount || 0)
        };
    });

    const firstPaymentYear = grp[0].academicYear || '';
    if (firstPaymentYear && firstPaymentYear !== selectedFeeAcademicYear) {
        selectedFeeAcademicYear = firstPaymentYear;
        populateFeeItemSelection();
    }

    editingPaymentGroup = { txnId, itemKeys: new Set(grp.map((p) => `${p.itemKey}__${p.academicYear || ''}`)) };

    document.getElementById('entry-receipt').value = grp[0].receiptNo || ''; document.getElementById('entry-date').value = grp[0].paymentDate;
    document.getElementById('entry-description').value = grp[0].description || ''; document.getElementById('total-amount').value = grp.reduce((s,p)=>s+p.amount, 0);
    const modeEl = document.getElementById('entry-payment-mode');
    if (modeEl) modeEl.value = grp[0].paymentMode || 'Cash';

    const groupedByStudent = grp.reduce((acc, payment) => {
        if (!acc[payment.studentId]) acc[payment.studentId] = [];
        acc[payment.studentId].push(payment);
        return acc;
    }, {});
    const groupStudentIds = Object.keys(groupedByStudent);
    if (groupStudentIds.length > 1) {
        selectedGroupMemberIds = new Set(groupStudentIds);
        const toggle = document.getElementById('multi-entry-toggle');
        if (toggle) toggle.checked = false;
        multiEntryQueue = [];
        renderMultiEntryQueue();
        syncGroupedStudentsForSelectedStudent();
    } else if (groupStudentIds.length === 1) {
        selectedGroupMemberIds = new Set(groupStudentIds);
        syncGroupedStudentsForSelectedStudent();
    }

    document.querySelectorAll('.fee-item-checkbox').forEach(cb => {
        const isPaidHere = editingPaymentGroup.itemKeys.has(`${cb.dataset.itemKey}__${selectedFeeAcademicYear || ''}`);
        const isPaidElsewhere = allPayments.some((payment) => {
            if (payment.studentId !== studentId || payment.itemKey !== cb.dataset.itemKey) return false;
            if ((payment.academicYear || '') !== (selectedFeeAcademicYear || '')) return false;
            return getPaymentGroupKey(payment) !== txnId;
        });
        
        cb.checked = isPaidHere; 
        cb.disabled = isPaidElsewhere;
        
        const labelEl = cb.nextElementSibling;
        labelEl.classList.remove('fee-item-paid-elsewhere', 'fee-item-editing-yellow', 'fee-item-new-green');
        
        if(isPaidHere) {
            labelEl.classList.add('fee-item-editing-yellow');
            const matchedPayment = grp.find((p) => p.itemKey === cb.dataset.itemKey && (p.academicYear || '') === (selectedFeeAcademicYear || ''));
            const card = cb.closest('.fee-month-item-card') || cb.closest('.relative');
            if(cb.dataset.itemType === 'custom') { 
                const input = card?.querySelector('.custom-fee-amount-input'); 
                if (input) {
                    input.value = matchedPayment?.amount || ''; 
                    input.classList.remove('hidden'); 
                }
            } else {
                const monthWrap = card?.querySelector('.month-amount-wrapper');
                const monthInput = card?.querySelector('.month-fee-amount-input');
                if (monthWrap) monthWrap.classList.remove('hidden');
                if (monthInput) monthInput.value = matchedPayment?.groupMonthAmount || matchedPayment?.amount || '';
            }
        } else if(isPaidElsewhere) { 
            labelEl.classList.add('fee-item-paid-elsewhere');
            cb.checked = true; // Visual check for disabled item
        }
    });
    checkReceiptMandatory();
};

const processPaymentSubmit = async (isUpdate) => {
    if (isPaymentMutationInFlight) return;
    if(!selectedStudentId && !multiEntryQueue.length) return alert("Please select a student.");
    captureCurrentYearFeeSelections();
    const selected = buildSelectedItemsForCurrentStudent();
    const selectedGroup = selectedStudentId ? getStudentBillingGroup(selectedStudentId) : null;

    // Determine target members for group if applicable
    const targetGroupMemberIds = selectedGroup && Array.isArray(selectedGroup.memberIds) && selectedGroup.memberIds.length > 1
        ? (selectedGroupMemberIds && selectedGroupMemberIds.size > 0 ? [...selectedGroupMemberIds] : selectedGroup.memberIds)
        : (selectedStudentId ? [selectedStudentId] : []);

    const isSingleMemberOnly = targetGroupMemberIds.length === 1;
    const isAllGroupMembers = selectedGroup && targetGroupMemberIds.length === selectedGroup.memberIds.length;
    const effectiveBillingGroupId = isAllGroupMembers ? selectedGroup.id : null;

    const primaryEntry = selectedStudentId ? {
        studentId: isSingleMemberOnly ? targetGroupMemberIds[0] : selectedStudentId,
        studentName: getStudentById(isSingleMemberOnly ? targetGroupMemberIds[0] : selectedStudentId)?.name || 'Student',
        classLabel: getStudentById(isSingleMemberOnly ? targetGroupMemberIds[0] : selectedStudentId)?.class || '',
        items: selected,
        total: selected.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        billingGroupId: effectiveBillingGroupId,
        targetGroupMemberIds: targetGroupMemberIds
    } : null;

    const allEntries = isMultiEntryMode() ? [...multiEntryQueue, primaryEntry].filter(Boolean) : [primaryEntry].filter(Boolean);
    if(allEntries.length === 0 || allEntries.every((entry) => !entry.items.length)) return alert("Please select at least one fee item.");

    const rcptStr = document.getElementById('entry-receipt').value.trim();
    const rcpt = rcptStr ? parseInt(rcptStr) : null;

    const isReq = checkReceiptMandatory();
    if(isReq && !rcpt) return alert("Receipt number is mandatory for the selected fee.");

    if(rcpt) {
        const isDup = allPayments.some((payment) => {
            if (payment.receiptNo !== rcpt || payment.collectedBy !== getCollectorKey()) return false;
            if (!isUpdate) return true;
            return getPaymentGroupKey(payment) !== editingPaymentGroup.txnId;
        });
        if(isDup) return alert(`Receipt number ${rcpt} is already used. Please provide a different number.`);
    }

    const dt = document.getElementById('entry-date').value;
    const desc = document.getElementById('entry-description').value.trim();
    const paymentMode = document.getElementById('entry-payment-mode')?.value || 'Cash';
    const visibleTotal = parseFloat(document.getElementById('total-amount').value || 0);
    const tot = isMultiEntryMode() ? allEntries.reduce((sum, e) => sum + Number(e.total || 0), 0) : visibleTotal;
    if(!dt || isNaN(tot)) return alert("Please check the date and amount.");

    const confirmBtn = document.getElementById('confirm-ok');
    document.getElementById('confirm-title').textContent = isUpdate ? 'Update Payment' : 'Confirm Payment';
    const confirmMessage = document.getElementById('confirm-message');
    const titleLine = document.createElement('p');
    titleLine.className = 'font-medium text-gray-800';

    if (isUpdate) {
        titleLine.textContent = 'Save changes to this payment?';
    } else if (isMultiEntryMode()) {
        titleLine.textContent = `Save fee payment for ${allEntries.length} students under receipt #${rcpt || 'Auto'}?`;
    } else if (isSingleMemberOnly) {
        const singleSt = getStudentById(targetGroupMemberIds[0]);
        titleLine.textContent = `Save individual fee payment for ${singleSt?.name || 'Student'}?`;
    } else if (targetGroupMemberIds.length > 1) {
        titleLine.textContent = `Save grouped fee payment for ${targetGroupMemberIds.length} students?`;
    } else {
        titleLine.textContent = `Save fee payment for ${getStudentById(selectedStudentId)?.name || 'Student'}?`;
    }

    const amountLine = document.createElement('p');
    amountLine.className = 'mt-2 text-sm text-gray-700 font-mono flex items-center justify-between border-t border-b py-1.5 border-slate-100';
    amountLine.innerHTML = `<span>Total Amount: <b>₹${tot}</b></span><span class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold text-xs border border-blue-200">Mode: ${escapeHtml(paymentMode)}</span>`;
    const detailsWrap = document.createElement('div');
    detailsWrap.className = 'mt-2 text-xs text-slate-600 space-y-1 max-h-40 overflow-y-auto';

    if (targetGroupMemberIds.length > 1 && !isMultiEntryMode()) {
        targetGroupMemberIds.forEach(id => {
            const stObj = getStudentById(id);
            if (stObj) {
                const row = document.createElement('div');
                row.className = 'flex justify-between gap-3 bg-slate-50 rounded px-2 py-1';
                row.innerHTML = `<span>${escapeHtml(stObj.name)} (${escapeHtml(stObj.class || '--')})</span><span class="text-emerald-700 font-semibold">Included</span>`;
                detailsWrap.appendChild(row);
            }
        });
    } else {
        const finalEntries = allEntries.filter((entry) => (entry.items || []).length);
        finalEntries.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'flex justify-between gap-3 bg-slate-50 rounded px-2 py-1';
            row.innerHTML = `<span>${escapeHtml(entry.studentName)} (${escapeHtml(entry.classLabel || '--')})</span><b>₹${Number(entry.total || 0).toFixed(0)}</b>`;
            detailsWrap.appendChild(row);
        });
    }

    confirmMessage.replaceChildren(titleLine, amountLine, detailsWrap);
    document.getElementById('confirm-popup').classList.remove('hidden');
    document.getElementById('confirm-popup').classList.add('flex');

    confirmBtn.onclick = async () => {
        if (isPaymentMutationInFlight) return;
        isPaymentMutationInFlight = true;
        confirmBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Processing...`;
        confirmBtn.disabled = true;
        const saveBtn = document.getElementById('save-fee-btn');
        const updateBtn = document.getElementById('update-fee-btn');
        if (saveBtn) saveBtn.disabled = true;
        if (updateBtn) updateBtn.disabled = true;
        try {
            const batch = writeBatch(db);
            const tId = isUpdate ? editingPaymentGroup.txnId : (Date.now().toString() + Math.random().toString(36).substr(2, 5));

            if(isUpdate) {
                const docsToDelete = await collectPaymentDocsForGroup(editingPaymentGroup.txnId, '');
                docsToDelete.forEach((docSnap) => {
                    batch.delete(docSnap.ref);
                    const payment = docSnap.data();
                    const yearPath = getYearPaymentsCollectionPath(payment.academicYear || '');
                    batch.delete(doc(db, yearPath, docSnap.id));
                });
            }

            const currentStaffName = isCurrentAdmin ? 'Administrator' : (allStaff.find(s=>s.email===currentUserEmail)?.name || currentUserEmail);
            const writtenGroupedMonthlyItems = new Set();

            allEntries.forEach((entry) => {
                const entrySelected = entry.items || [];
                if (!entrySelected.length) return;
                const customCbs = entrySelected.filter((item) => item.itemType === 'custom');
                const monthlyCbs = entrySelected.filter((item) => (item.itemType || 'month') === 'month');
                const studentClass = students.find((student) => student.id === entry.studentId)?.class || '';
                const common = {
                    receiptNo: rcpt,
                    transactionId: tId,
                    paymentDate: dt,
                    paymentMode: paymentMode,
                    timestamp: Date.now(),
                    description: desc,
                    collectedBy: getCollectorKey(),
                    collectedByName: currentStaffName,
                    academicYear: selectedFeeAcademicYear || '',
                    classLabel: studentClass
                };

                // Write custom fee items
                customCbs.forEach((item) => {
                    queuePaymentWrite(batch, {
                        ...common,
                        academicYear: item.year || common.academicYear,
                        studentId: entry.studentId,
                        itemKey: item.itemKey,
                        amount: Number(item.amount || 0),
                        billingGroupId: null
                    });
                });

                // Write monthly fee items
                if (monthlyCbs.length > 0) {
                    const targets = entry.targetGroupMemberIds && entry.targetGroupMemberIds.length > 0
                        ? entry.targetGroupMemberIds
                        : [entry.studentId];

                    monthlyCbs.forEach((item) => {
                        const itemYear = item.year || common.academicYear;
                        const itemMonthAmount = Number(item.amount || 0);

                        if (targets.length === 1) {
                            // Single student payment ONLY - unchecked siblings remain unpaid without arrears!
                            const singleId = targets[0];
                            const singleClass = students.find(s => s.id === singleId)?.class || studentClass;
                            queuePaymentWrite(batch, {
                                ...common,
                                academicYear: itemYear,
                                studentId: singleId,
                                classLabel: singleClass,
                                itemKey: item.itemKey,
                                amount: itemMonthAmount,
                                groupMonthAmount: itemMonthAmount,
                                billingGroupId: null
                            });
                        } else {
                            // Multiple / all group members payment
                            const billingGroupId = entry.billingGroupId || null;
                            const groupedItemKey = billingGroupId ? `${billingGroupId}__${item.itemKey}__${itemYear}` : '';
                            if (groupedItemKey && writtenGroupedMonthlyItems.has(groupedItemKey)) return;
                            if (groupedItemKey) writtenGroupedMonthlyItems.add(groupedItemKey);

                            const splitAmt = roundMoney(itemMonthAmount / targets.length);
                            targets.forEach((id, idx) => {
                                const isLast = idx === targets.length - 1;
                                const studentAmt = isLast
                                    ? roundMoney(itemMonthAmount - (splitAmt * (targets.length - 1)))
                                    : splitAmt;
                                const memberClass = students.find(s => s.id === id)?.class || studentClass;
                                queuePaymentWrite(batch, {
                                    ...common,
                                    academicYear: itemYear,
                                    studentId: id,
                                    classLabel: memberClass,
                                    itemKey: item.itemKey,
                                    amount: Math.max(0, studentAmt),
                                    groupMonthAmount: itemMonthAmount,
                                    billingGroupId
                                });
                            });
                        }
                    });
                }
            });

            await batch.commit();
            if(!isUpdate) document.getElementById('entry-receipt').value = rcpt ? rcpt + 1 : '';
            exitEditMode();
            showToast('Payment saved successfully!', 'success');
        } catch (e) {
            console.error(e);
            alert("Failed to save payment. Please try again.");
        } finally {
            isPaymentMutationInFlight = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'OK';
            if (saveBtn) saveBtn.disabled = false;
            if (updateBtn) updateBtn.disabled = false;
            document.getElementById('confirm-popup').classList.add('hidden');
        }
    };
};

document.getElementById('save-fee-btn').addEventListener('click', () => processPaymentSubmit(false));
document.getElementById('update-fee-btn').addEventListener('click', () => processPaymentSubmit(true));


// --- BULK UPLOAD LOGIC ---
const setupBulkUploadUI = () => {
    const yearSelect = document.getElementById('bulk-academic-year');
    if (yearSelect) {
        yearSelect.innerHTML = `<option value="">-- Select Academic Year --</option>` +
            academicYearSettings.filter(y => y.status !== 'archived').map(y => `<option value="${y.label}">${y.label}</option>`).join('');
        if (currentWorkingAcademicYear) yearSelect.value = currentWorkingAcademicYear;
    }
    document.getElementById('bulk-default-fee').value = defaultFee;
    document.getElementById('bulk-progress-container').classList.add('hidden');
    document.getElementById('bulk-preview-area').classList.add('hidden');
    document.getElementById('bulk-drop-zone').classList.remove('hidden');
    document.getElementById('bulk-file-input').value = '';
    window.bulkUploadParsedData = null;
};

// EXCEL/CSV Template Download Logic
document.getElementById('bulk-download-btn')?.addEventListener('click', () => {
    const year = document.getElementById('bulk-academic-year').value;
    const targetClass = document.getElementById('bulk-class').value;
    const defFee = document.getElementById('bulk-default-fee').value;

    if (!year || !targetClass || !defFee) {
        alert("Please provide Academic Year, Target Class, and Default Fee.");
        return;
    }

    const filteredStudents = allStudentsRaw.filter(s => s.class === targetClass && (s.academicYear || currentWorkingAcademicYear) === year);
    if (filteredStudents.length === 0) {
        alert("No students found in this class for the selected academic year.");
        return;
    }

    const monthlyItems = sortMonthlyItemsByAcademicYear(
        feeItems.filter(item => (item.type || 'month') === 'month' && (!item.academicYear || item.academicYear === year)),
        year
    );

    if (monthlyItems.length === 0) {
        alert("No monthly fee items found for this academic year.");
        return;
    }

    // 1. Create Headers
    let headers = ['Student_ID', 'Admission_No', 'Student_Name'];
    monthlyItems.forEach(item => {
        const safeName = normalizeFeeItemName(item.name).replace(/[^a-zA-Z0-9]/g, '_');
        headers.push(`${safeName}_Amount`);
        headers.push(`${safeName}_ReceiptNo`);
        headers.push(`${safeName}_Date`);
    });

    const rowsData = [headers];

    // 2. Create Model Row (Sample Entry)
    const todayStr = new Date().toISOString().split('T')[0];
    const modelRow = ['SAMPLE-ID-DO-NOT-DELETE', '1234', 'Model Student Name'];
    monthlyItems.forEach(() => {
        modelRow.push(defFee);     // Amount
        modelRow.push('1001');     // Sample Receipt No
        modelRow.push(todayStr);   // Date YYYY-MM-DD
    });
    rowsData.push(modelRow);

    // 3. Add Actual Student Data
    filteredStudents.sort((a,b) => (a.name || '').localeCompare(b.name || '')).forEach(student => {
        const rowData = [
            student.id,
            student.adm || '',
            student.name || ''
        ];

        monthlyItems.forEach(() => {
            rowData.push(defFee); // Amount pre-filled
            rowData.push('');     // Empty Receipt
            rowData.push('');     // Empty Date
        });
        rowsData.push(rowData);
    });

    // Generate Excel File using SheetJS
    try {
        const ws = XLSX.utils.aoa_to_sheet(rowsData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Fee_Template");
        
        const safeClassName = targetClass.replace(/[^a-zA-Z0-9]/g, '_');
        XLSX.writeFile(wb, `Bulk_Fee_Template_${safeClassName}_${year}.xlsx`);
    } catch (e) {
        console.error("Excel generation failed:", e);
        alert("Failed to generate template. Please try again.");
    }
});

// SheetJS Excel/CSV Upload & Parse Logic
const handleBulkFileSelection = (file) => {
    if (!file) return;
    const year = document.getElementById('bulk-academic-year').value;
    const targetClass = document.getElementById('bulk-class').value;

    if (!year || !targetClass) {
        alert("Please select both Academic Year and Target Class before uploading.");
        document.getElementById('bulk-file-input').value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // Convert to Array of Arrays
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
            
            if (rows.length < 2) {
                alert("No data found in the file.");
                return;
            }

            const headers = rows[0];
            if (headers[0] !== 'Student_ID' || headers[1] !== 'Admission_No') {
                alert("Invalid file format. Please use the downloaded template.");
                return;
            }

            const monthlyItems = sortMonthlyItemsByAcademicYear(
                feeItems.filter(item => (item.type || 'month') === 'month' && (!item.academicYear || item.academicYear === year)),
                year
            );

            window.bulkUploadParsedData = { rows: rows.slice(1), headers, monthlyItems, year, targetClass };
            
            document.getElementById('bulk-file-name').textContent = file.name;
            document.getElementById('bulk-record-count').textContent = `Found ${rows.length - 1} rows to check`;
            document.getElementById('bulk-drop-zone').classList.add('hidden');
            document.getElementById('bulk-preview-area').classList.remove('hidden');
            document.getElementById('bulk-start-upload-btn').disabled = false;
            document.getElementById('bulk-start-upload-btn').innerHTML = `<i class="fas fa-cogs"></i> Start Processing`;
            document.getElementById('bulk-progress-container').classList.add('hidden');

        } catch (error) {
            console.error("Parse Error:", error);
            alert("Error reading file. Please ensure it is a valid Excel/CSV file.");
            document.getElementById('bulk-file-input').value = '';
        }
    };
    reader.readAsArrayBuffer(file);
};

document.getElementById('bulk-file-input')?.addEventListener('change', (e) => handleBulkFileSelection(e.target.files[0]));

const bulkDropZone = document.getElementById('bulk-drop-zone');
if (bulkDropZone) {
    bulkDropZone.addEventListener('dragover', (e) => { e.preventDefault(); bulkDropZone.classList.add('dragover'); });
    bulkDropZone.addEventListener('dragleave', () => bulkDropZone.classList.remove('dragover'));
    bulkDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        bulkDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleBulkFileSelection(e.dataTransfer.files[0]);
    });
    bulkDropZone.addEventListener('click', () => document.getElementById('bulk-file-input').click());
}

document.getElementById('bulk-cancel-btn')?.addEventListener('click', setupBulkUploadUI);

document.getElementById('bulk-start-upload-btn')?.addEventListener('click', async () => {
    if (!window.bulkUploadParsedData) return;
    
    const btn = document.getElementById('bulk-start-upload-btn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;
    
    document.getElementById('bulk-progress-container').classList.remove('hidden');
    const progressBar = document.getElementById('bulk-progress-bar');
    const progressPct = document.getElementById('bulk-progress-pct');
    const progressText = document.getElementById('bulk-progress-text');
    
    const { rows, headers, monthlyItems, year, targetClass } = window.bulkUploadParsedData;
    const collectorName = isCurrentAdmin ? 'Administrator' : (allStaff.find(s => s.email === currentUserEmail)?.name || currentUserEmail);
    const collectorUserKey = getCollectorKey();

    let paymentOperations = [];
    let autoReceiptNo = getNextReceiptNoForStaff() || 1;

    for (const row of rows) {
        if (!row || row.length < 3) continue;
        const studentId = String(row[0]).trim();
        
        // Skip Model/Sample row automatically
        if (studentId === 'SAMPLE-ID-DO-NOT-DELETE') continue;

        const student = allStudentsRaw.find(s => s.id === studentId);
        if (!student || student.class !== targetClass || (student.academicYear || currentWorkingAcademicYear) !== year) {
            continue; 
        }

        let transactionId = Date.now().toString() + Math.random().toString(36).substring(2, 6);

        monthlyItems.forEach((item) => {
            const safeName = normalizeFeeItemName(item.name).replace(/[^a-zA-Z0-9]/g, '_');
            const amtIndex = headers.indexOf(`${safeName}_Amount`);
            const rcptIndex = headers.indexOf(`${safeName}_ReceiptNo`);
            const dateIndex = headers.indexOf(`${safeName}_Date`);

            if (amtIndex !== -1 && dateIndex !== -1) {
                const amtVal = parseFloat(row[amtIndex]);
                // SheetJS might convert dates to numbers, or return formatted string
                // We handle common JS Date casting if needed, or simple string read
                const rawDate = row[dateIndex];
                let dateVal = '';
                
                if (typeof rawDate === 'number') {
                    // Excel date serial number handling
                    const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
                    dateVal = d.toISOString().split('T')[0];
                } else if (rawDate) {
                    dateVal = String(rawDate).trim();
                }

                const rcptVal = rcptIndex !== -1 ? String(row[rcptIndex] || '').trim() : '';

                if (!isNaN(amtVal) && amtVal > 0 && dateVal) {
                    // Validate basic YYYY-MM-DD
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
                        console.warn(`Invalid date format for student ${student.name}. Expected YYYY-MM-DD. Found: ${dateVal}`);
                        return;
                    }

                    const isAlreadyPaid = allPayments.some(p => p.studentId === studentId && p.itemKey === item.key && (p.academicYear || '') === year);
                    if (isAlreadyPaid) return;

                    let finalReceiptNo = null;
                    if (rcptVal) {
                        finalReceiptNo = parseInt(rcptVal, 10);
                    } else {
                        finalReceiptNo = autoReceiptNo;
                        autoReceiptNo++;
                    }

                    const paymentData = {
                        studentId: studentId,
                        itemKey: item.key,
                        amount: amtVal,
                        receiptNo: finalReceiptNo,
                        transactionId: transactionId,
                        paymentDate: dateVal,
                        timestamp: new Date(dateVal).getTime() || Date.now(),
                        description: "Bulk Upload",
                        collectedBy: collectorUserKey,
                        collectedByName: collectorName,
                        academicYear: year,
                        classLabel: student.class || ''
                    };
                    paymentOperations.push(paymentData);
                }
            }
        });
    }

    if (paymentOperations.length === 0) {
        alert("No valid fee data found to upload. (Previously paid items were skipped).");
        setupBulkUploadUI();
        return;
    }

    const CHUNK_SIZE = 150; 
    let successCount = 0;

    try {
        for (let i = 0; i < paymentOperations.length; i += CHUNK_SIZE) {
            const batch = writeBatch(db);
            const chunk = paymentOperations.slice(i, i + CHUNK_SIZE);
            
            chunk.forEach(payload => {
                queuePaymentWrite(batch, payload);
            });
            
            await batch.commit();
            successCount += chunk.length;
            
            const pct = Math.round((successCount / paymentOperations.length) * 100);
            progressBar.style.width = `${pct}%`;
            progressPct.textContent = `${pct}%`;
            progressText.textContent = `Saving ${successCount} of ${paymentOperations.length}...`;
        }

        progressBar.style.width = `100%`;
        progressPct.textContent = `100%`;
        progressText.textContent = "Upload Complete!";
        
        setTimeout(() => {
            alert(`Success! ${successCount} fee records updated in the system.`);
            setupBulkUploadUI();
            document.querySelector('.nav-link[data-target="dashboard-page"]')?.click();
        }, 800);

    } catch (error) {
        console.error("Bulk Upload Error:", error);
        alert("An error occurred during upload. Please check your network connection.");
        setupBulkUploadUI();
    }
});


const downloadFeeStatusPdf = () => {
    const { list, items: rawItems } = buildFeeStatusMatrix();
    const items = sortFeeItemsForDisplay(rawItems);
    if (!list.length || !items.length) {
        alert('No fee status data available to export.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF({ orientation: items.length > 6 ? 'landscape' : 'portrait' });
    const title = document.getElementById('fee-status-title-header')?.textContent || 'Fee Status';
    const conf = window.institutionConfig || {};
    const institutionName = conf.appName || document.getElementById('header-title')?.textContent || 'Institution';
    const placeText = conf.place || document.getElementById('header-place')?.textContent?.trim() || '';
    const regRaw = conf.regNo || document.getElementById('header-regno')?.textContent?.trim() || '';
    const regText = regRaw && regRaw.toLowerCase().includes('reg') ? regRaw : (regRaw ? `Reg No: ${regRaw}` : '');
    const regPlace = [placeText, regText].filter(Boolean).join(' • ');
    const generatedOn = new Date().toLocaleString();
    const selectedClass = document.getElementById('filter-class')?.value || 'all';
    const classLabel = selectedClass === 'all' ? 'All Classes' : selectedClass;
    const pageWidth = docPdf.internal.pageSize.getWidth();

    docPdf.setFontSize(16);
    docPdf.text(institutionName, pageWidth / 2, 14, { align: 'center' });
    docPdf.setFontSize(10);
    docPdf.text(regPlace || '--', pageWidth / 2, 20, { align: 'center' });
    docPdf.text(`Generated: ${generatedOn}`, pageWidth / 2, 26, { align: 'center' });
    docPdf.setFontSize(12);
    docPdf.text(title, 14, 34);
    docPdf.text(`Class: ${classLabel}`, pageWidth / 2, 34, { align: 'center' });

    const groupedClasses = Object.values(list.reduce((acc, student) => {
        const classKey = String(student.class || '--');
        if (!acc[classKey]) acc[classKey] = { classLabel: classKey, male: [], female: [] };
        const gender = String(student.gender || '').toLowerCase();
        if (gender === 'male') acc[classKey].male.push(student);
        else acc[classKey].female.push(student);
        return acc;
    }, {})).sort((a, b) => a.classLabel.localeCompare(b.classLabel, undefined, { numeric: true }));

    const buildRows = (students = []) => students
        .sort((a, b) => String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || '')))
        .map((student, idx) => {
            const row = [idx + 1, student.adm || '-', student.name];
            items.forEach((item) => {
                const payment = allPayments.find((pay) => pay.studentId === student.id && pay.itemKey === item.key);
                if (payment) {
                    if (payment.receiptNo !== undefined && payment.receiptNo !== null && String(payment.receiptNo).trim() !== '') {
                        row.push(String(payment.receiptNo).trim());
                    } else {
                        row.push('Paid');
                    }
                } else {
                    row.push('');
                }
            });
            return row;
        });

    let currentY = 40;
    groupedClasses.forEach((classGroup, classIndex) => {
        if (classIndex > 0) currentY = docPdf.lastAutoTable ? docPdf.lastAutoTable.finalY + 10 : currentY + 10;
        docPdf.setFontSize(11);
        docPdf.text(`Class: ${classGroup.classLabel}`, 14, currentY);
        currentY += 3;

        const maleRows = buildRows(classGroup.male);
        if (maleRows.length) {
            docPdf.autoTable({
                startY: currentY,
                head: [[ 'Sl No', 'Adm No', 'Student (Boys)', ...items.map((item) => normalizeFeeItemName(item.name)) ]],
                body: maleRows,
                styles: { fontSize: 8, cellPadding: 2 },
                headStyles: { fillColor: [37, 99, 235] },
                alternateRowStyles: { fillColor: [248, 250, 252] }
            });
            currentY = docPdf.lastAutoTable.finalY + 4;
        }

        const femaleRows = buildRows(classGroup.female);
        if (femaleRows.length) {
            docPdf.autoTable({
                startY: currentY,
                head: [[ 'Sl No', 'Adm No', 'Student (Girls)', ...items.map((item) => normalizeFeeItemName(item.name)) ]],
                body: femaleRows,
                styles: { fontSize: 8, cellPadding: 2 },
                headStyles: { fillColor: [16, 185, 129] },
                alternateRowStyles: { fillColor: [248, 250, 252] }
            });
            currentY = docPdf.lastAutoTable.finalY + 4;
        }
    });

    docPdf.save(`${title.toLowerCase().replace(/[^a-z0-9]+/gi, '-') || 'fee-status'}.pdf`);
};

document.getElementById('fee-download-pdf-btn')?.addEventListener('click', downloadFeeStatusPdf);

// --- FEE STATUS BULK SELECTION & RENDER ---
const selectedFeeStatusCells = new Map();

const updateFeeStatusBulkActionButtons = () => {
    const actionsWrap = document.getElementById('fee-status-bulk-actions');
    const collectBtn = document.getElementById('fee-status-bulk-collect-btn');
    const collectLabel = document.getElementById('fee-status-bulk-collect-label');
    const editBtn = document.getElementById('fee-status-bulk-edit-btn');
    const editLabel = document.getElementById('fee-status-bulk-edit-label');

    let payCount = 0;
    let editCount = 0;
    selectedFeeStatusCells.forEach(val => {
        if (val.type === 'pay') payCount += 1;
        else if (val.type === 'edit') editCount += 1;
    });

    if (actionsWrap) {
        const hasAny = payCount > 0 || editCount > 0;
        actionsWrap.classList.toggle('hidden', !hasAny);
        actionsWrap.classList.toggle('flex', hasAny);
    }

    if (collectBtn && collectLabel) {
        collectBtn.classList.toggle('hidden', payCount === 0);
        collectBtn.classList.toggle('flex', payCount > 0);
        collectLabel.textContent = `Collect (${payCount})`;
    }

    if (editBtn && editLabel) {
        editBtn.classList.toggle('hidden', editCount === 0);
        editBtn.classList.toggle('flex', editCount > 0);
        editLabel.textContent = `Edit (${editCount})`;
    }
};

const clearFeeStatusBulkSelection = () => {
    selectedFeeStatusCells.clear();
    document.querySelectorAll('.fee-status-cell-cb').forEach(cb => {
        cb.checked = false;
        const td = cb.closest('td');
        if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
    });
    document.querySelectorAll('.fee-status-col-all-cb, .fee-status-row-all-cb').forEach(cb => {
        cb.checked = false;
    });
    updateFeeStatusBulkActionButtons();
};

const openFeeStatusBulkActionModal = (actionType = 'pay') => {
    const bulkItems = [];
    const effectiveAcademicYear = selectedFeeAcademicYear || currentWorkingAcademicYear || getAcademicYearFromDate();

    selectedFeeStatusCells.forEach((sel, selKey) => {
        if (sel.type !== actionType) return;
        const s = getStudentById(sel.studentId);
        if (!s) return;

        const cbEl = document.querySelector(`.fee-status-cell-cb[data-sel-key="${CSS.escape(selKey)}"]`);
        const cellEl = cbEl ? cbEl.closest('td') : null;

        if (actionType === 'pay') {
            bulkItems.push({
                studentId: s.id,
                studentName: s.name || 'Student',
                studentClass: s.class || '-',
                studentAdm: s.adm || '',
                guardian: s.guardian || s.father || '',
                month: sel.itemName || sel.itemKey,
                itemKey: sel.itemKey,
                itemName: sel.itemName || `${sel.itemKey} Tuition Fee`,
                itemType: sel.itemType || 'month',
                amount: Number(sel.defaultAmount || defaultFee || 200),
                academicYear: effectiveAcademicYear,
                targetCellElement: cellEl
            });
        } else if (actionType === 'edit') {
            const payment = allPayments.find(p => (sel.paymentId && p.id === sel.paymentId) || (p.studentId === sel.studentId && p.itemKey === sel.itemKey));
            if (payment) {
                bulkItems.push({
                    paymentId: payment.id,
                    payment: payment,
                    studentId: s.id,
                    studentName: s.name || payment.studentName || 'Student',
                    studentClass: s.class || payment.studentClass || '-',
                    guardian: s.guardian || s.father || payment.guardianName || '',
                    month: sel.itemName || sel.itemKey,
                    itemKey: payment.itemKey || sel.itemKey,
                    itemName: payment.itemName || sel.itemName || 'Tuition Fee',
                    amount: Number(payment.amount || sel.defaultAmount || defaultFee || 200),
                    academicYear: payment.academicYear || effectiveAcademicYear,
                    targetCellElement: cellEl
                });
            }
        }
    });

    if (bulkItems.length === 0) {
        showToast('No valid items selected.', 'info');
        return;
    }

    openFeeEntryEditModal({
        source: 'fee-status',
        mode: actionType === 'edit' ? 'bulk-edit' : 'bulk-add',
        bulkItems: bulkItems,
        academicYear: effectiveAcademicYear,
        onUpdated: () => {
            clearFeeStatusBulkSelection();
        }
    });
};

document.getElementById('fee-status-clear-sel-btn')?.addEventListener('click', () => {
    clearFeeStatusBulkSelection();
    showToast('Selection cleared.', 'info');
});
document.getElementById('fee-status-bulk-collect-btn')?.addEventListener('click', () => openFeeStatusBulkActionModal('pay'));
document.getElementById('fee-status-bulk-edit-btn')?.addEventListener('click', () => openFeeStatusBulkActionModal('edit'));

const renderFeeTable = () => {
    const cont = document.getElementById('fee-table-container');
    if (!cont) return;
    const { list, items: rawItems } = buildFeeStatusMatrix();
    const items = sortFeeItemsForDisplay(rawItems);
    if(list.length === 0) { cont.innerHTML = `<p class="text-gray-500 text-center py-6">No data found.</p>`; return; }

    if (items.length === 0) { cont.innerHTML = `<p class="text-gray-500 text-center py-6">No fee items configured.</p>`; return; }

    const matrixYears = [...new Set(items.map((item) => item.academicYear).filter(Boolean))];
    const matrixYearLabel = matrixYears.length === 1 ? matrixYears[0] : (matrixYears.length ? 'Multi-Year' : (selectedFeeAcademicYear || getAcademicYearFromDate()));
    const headerEl = document.getElementById('fee-status-title-header');
    if (headerEl) headerEl.textContent = `${feeStatusTitle || 'Fee Status'} (${matrixYearLabel})`;

    let html = `<table class="w-full text-xs text-left whitespace-nowrap border-collapse">
        <thead class="table-header sticky top-0 bg-slate-50 z-20 shadow-xs border-b border-slate-200">
            <tr>
                <th class="p-3 sticky left-0 bg-slate-50 z-30 border-r border-slate-200 text-slate-700 font-extrabold w-12 text-center">NO</th>
                <th class="p-3 sticky left-12 bg-slate-50 z-30 border-r border-slate-200 text-slate-700 font-extrabold w-20">Adm.No</th>
                <th class="p-3 sticky left-32 bg-slate-50 z-30 border-r border-slate-200 text-slate-700 font-extrabold min-w-[220px]">Student Name</th>
                ${items.map(i=>`<th class="p-2.5 border-r border-slate-200 text-center font-bold text-slate-700 min-w-[105px]">
                    <div class="flex flex-col items-center gap-1">
                        <span>${escapeHtml(normalizeFeeItemName(i.name))}</span>
                        <input type="checkbox" class="fee-status-col-all-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer" data-item-key="${escapeHtml(i.key)}" title="Select all unpaid in ${escapeHtml(normalizeFeeItemName(i.name))}">
                    </div>
                </th>`).join('')}
            </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 font-medium">`;

    const sortedGroups = Object.values(list.reduce((acc, s) => {
        const k = `${s.class}#${s.gender}`;
        if (!acc[k]) acc[k] = { class: s.class, gender: s.gender, students: [] };
        acc[k].students.push(s);
        return acc;
    }, {}))
    .sort((a, b) => {
        const classCompare = a.class.localeCompare(b.class, undefined, { numeric: true });
        if (classCompare !== 0) return classCompare;
        if (a.gender === 'Male' && b.gender !== 'Male') return -1;
        if (a.gender !== 'Male' && b.gender === 'Male') return 1;
        return 0;
    });

    const orderedEntries = [];
    for (const g of sortedGroups) {
        const sortedGroupStudents = [...g.students].sort((a, b) => (a.adm || '').localeCompare(b.adm || '', undefined, { numeric: true }));
        sortedGroupStudents.forEach(s => {
            orderedEntries.push({
                student: s,
                groupKey: `${g.class}#${g.gender}`,
                groupClass: g.class,
                groupGender: g.gender,
                groupTotalCount: g.students.length
            });
        });
    }

    const totalStudentsCount = orderedEntries.length;
    if (feeStatusPageOffset >= totalStudentsCount) {
        feeStatusPageOffset = Math.max(0, Math.floor((totalStudentsCount - 1) / feeStatusRowLimit) * feeStatusRowLimit);
    }

    const pageSlice = orderedEntries.slice(feeStatusPageOffset, feeStatusPageOffset + feeStatusRowLimit);
    const startNumber = totalStudentsCount > 0 ? feeStatusPageOffset + 1 : 0;
    const endNumber = feeStatusPageOffset + pageSlice.length;

    let currentGroupKey = null;

    pageSlice.forEach((entry, idx) => {
        const s = entry.student;
        const serialNo = feeStatusPageOffset + idx + 1;

        if (entry.groupKey !== currentGroupKey) {
            currentGroupKey = entry.groupKey;
            html += `<tr class="bg-slate-100 font-extrabold text-slate-800 tracking-wide text-xs">
                <td colspan="${items.length+3}" class="p-2.5 px-4 bg-slate-100 border-y border-slate-200">
                    <span class="inline-flex items-center gap-2">
                        <span class="w-2.5 h-2.5 rounded-full bg-blue-600"></span>
                        <span>${escapeHtml(entry.groupClass)} - ${escapeHtml(entry.groupGender)}</span>
                        <span class="text-[11px] text-slate-500 font-semibold font-mono">(${entry.groupTotalCount} students)</span>
                    </span>
                </td>
            </tr>`;
        }

        const isRowAllSelected = items.length > 0 && items.every(i => selectedFeeStatusCells.has(`${s.id}__${i.key}`));

        html += `<tr class="hover:bg-slate-50/80 bg-white transition border-b border-slate-100">
            <td class="p-2.5 font-bold text-slate-500 text-center sticky left-0 bg-white z-10 border-r border-slate-200 w-12">${serialNo}</td>
            <td class="p-2.5 font-mono text-slate-600 sticky left-12 bg-white z-10 border-r border-slate-200 w-20">${escapeHtml(s.adm || '-')}</td>
            <td class="p-2.5 font-bold text-slate-900 border-r border-slate-200 sticky left-32 bg-white z-10 min-w-[220px]">
                <div class="flex items-center justify-between gap-2">
                    <span class="truncate">${escapeHtml(s.name)}</span>
                    <input type="checkbox" class="fee-status-row-all-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer flex-shrink-0" data-student-id="${escapeHtml(s.id)}" ${isRowAllSelected ? 'checked' : ''} title="Select all fees for ${escapeHtml(s.name)}">
                </div>
            </td>`;

        items.forEach(i => {
            const p = allPayments.find(pay => pay.studentId === s.id && isFeeItemMatch(pay.itemKey, i) && (!pay.academicYear || !i.academicYear || pay.academicYear === i.academicYear));
            const selKey = `${s.id}__${i.key}`;
            const isSelected = selectedFeeStatusCells.has(selKey);
            const selRing = isSelected ? 'ring-2 ring-blue-500 ring-inset bg-blue-50/70' : '';
            const itemDefaultAmt = (s.concessionFee !== undefined && s.concessionFee !== null && s.concessionFee !== '' && (i.type || 'month') === 'month')
                ? Number(s.concessionFee)
                : Number(i.amount || defaultFee || 200);

            if(p) {
                html += `<td class="p-1.5 text-center bg-emerald-50/60 border-r border-slate-200 cursor-pointer hover:bg-emerald-100/90 transition group relative ${selRing}"
                    data-fee-action="view-receipt" data-payment-id="${p.id || ''}" data-student-id="${s.id}" data-item-key="${i.key}"
                    title="Click to view receipt slip or tick checkbox to bulk edit">
                    <div class="flex items-center justify-between mb-0.5 px-0.5">
                        <input type="checkbox" class="fee-status-cell-cb w-3.5 h-3.5 rounded border-emerald-400 text-amber-600 focus:ring-amber-500 cursor-pointer"
                            data-sel-key="${escapeHtml(selKey)}"
                            data-student-id="${escapeHtml(s.id)}"
                            data-item-key="${escapeHtml(i.key)}"
                            data-item-name="${escapeHtml(normalizeFeeItemName(i.name))}"
                            data-item-type="${escapeHtml(i.type || 'month')}"
                            data-default-amount="${itemDefaultAmt}"
                            data-sel-type="edit"
                            data-payment-id="${escapeHtml(p.id || '')}"
                            ${isSelected ? 'checked' : ''}
                            title="Select to bulk edit">
                        <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-black border border-emerald-200">
                            <i class="fas fa-check text-[7px]"></i> Paid
                        </span>
                    </div>
                    <div class="flex flex-col items-center justify-center">
                        <span class="text-[10px] font-mono font-bold text-emerald-950">${p.receiptNo ? `R:${escapeHtml(p.receiptNo)}` : `₹${Number(p.amount||0).toFixed(0)}`}</span>
                        <span class="text-[9px] text-emerald-600 font-medium">${new Date(p.paymentDate).toLocaleDateString('en-GB')}</span>
                    </div>
                </td>`;
            } else {
                html += `<td class="p-1.5 text-center bg-white border-r border-slate-200 cursor-pointer hover:bg-blue-50/80 transition group relative ${selRing}"
                    data-fee-action="pay-fee" data-student-id="${s.id}" data-item-key="${i.key}" data-item-name="${escapeHtml(normalizeFeeItemName(i.name))}" data-item-type="${i.type || 'month'}" data-default-amount="${itemDefaultAmt}"
                    title="Click to record fee payment or tick checkbox for multi-entry">
                    <div class="flex items-center justify-between mb-1 px-0.5">
                        <input type="checkbox" class="fee-status-cell-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            data-sel-key="${escapeHtml(selKey)}"
                            data-student-id="${escapeHtml(s.id)}"
                            data-item-key="${escapeHtml(i.key)}"
                            data-item-name="${escapeHtml(normalizeFeeItemName(i.name))}"
                            data-item-type="${escapeHtml(i.type || 'month')}"
                            data-default-amount="${itemDefaultAmt}"
                            data-sel-type="pay"
                            ${isSelected ? 'checked' : ''}
                            title="Select to collect together">
                        <span class="text-[9px] font-bold text-rose-500">Unpaid</span>
                    </div>
                    <div class="flex flex-col items-center justify-center">
                        <button type="button" class="w-full py-0.5 rounded-md bg-blue-50 group-hover:bg-blue-600 group-hover:text-white text-blue-700 text-[10px] font-bold border border-blue-200 transition shadow-2xs">
                            Pay
                        </button>
                    </div>
                </td>`;
            }
        });
        html += `</tr>`;
    });

    html += `</tbody></table>`;

    const hasPrevPage = feeStatusPageOffset > 0;
    const hasNextPage = endNumber < totalStudentsCount;

    if (totalStudentsCount > 0) {
        html += `
            <div class="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3.5 bg-slate-50 border-t border-slate-200">
                <span class="text-xs font-bold text-slate-600">
                    Showing <span class="text-slate-900 font-extrabold">${startNumber} - ${endNumber}</span> of <span class="text-slate-900 font-extrabold">${totalStudentsCount}</span> students
                </span>
                <div class="flex items-center gap-2">
                    <button type="button" id="fee-status-prev-btn" ${!hasPrevPage ? 'disabled' : ''} class="px-4 py-2 ${hasPrevPage ? 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 cursor-pointer' : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'} rounded-xl text-xs font-extrabold shadow-2xs transition inline-flex items-center gap-1.5">
                        <i class="fas fa-arrow-left text-[10px]"></i>
                        <span>Previous</span>
                    </button>
                    <button type="button" id="fee-status-load-next-btn" ${!hasNextPage ? 'disabled' : ''} class="px-5 py-2 ${hasNextPage ? 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} rounded-xl text-xs font-extrabold shadow-xs transition inline-flex items-center gap-1.5">
                        <span>Next</span>
                        <i class="fas fa-arrow-right text-[10px]"></i>
                    </button>
                </div>
            </div>
        `;
    }

    const prevScrollLeft = cont.scrollLeft;
    cont.innerHTML = html;
    cont.scrollTop = 0;
    cont.scrollLeft = prevScrollLeft;

    document.getElementById('fee-status-prev-btn')?.addEventListener('click', () => {
        if (feeStatusPageOffset > 0) {
            feeStatusPageOffset = Math.max(0, feeStatusPageOffset - feeStatusRowLimit);
            renderFeeTable();
        }
    });

    document.getElementById('fee-status-load-next-btn')?.addEventListener('click', () => {
        if (feeStatusPageOffset + feeStatusRowLimit < totalStudentsCount) {
            feeStatusPageOffset += feeStatusRowLimit;
            renderFeeTable();
        }
    });

    // Attach column header checkbox listeners for Fee Status
    cont.querySelectorAll('.fee-status-col-all-cb').forEach(colCb => {
        colCb.addEventListener('click', (e) => e.stopPropagation());
        colCb.addEventListener('change', () => {
            const itemKey = colCb.dataset.itemKey;
            const shouldCheck = colCb.checked;
            const unpaidCbs = Array.from(cont.querySelectorAll(`.fee-status-cell-cb[data-item-key="${CSS.escape(itemKey)}"][data-sel-type="pay"]`));
            const targetCbs = unpaidCbs.length > 0
                ? unpaidCbs
                : Array.from(cont.querySelectorAll(`.fee-status-cell-cb[data-item-key="${CSS.escape(itemKey)}"]`));

            targetCbs.forEach(cb => {
                cb.checked = shouldCheck;
                const selKey = cb.dataset.selKey;
                const td = cb.closest('td');
                if (shouldCheck) {
                    selectedFeeStatusCells.set(selKey, {
                        studentId: cb.dataset.studentId,
                        itemKey: cb.dataset.itemKey,
                        itemName: cb.dataset.itemName,
                        itemType: cb.dataset.itemType || 'month',
                        defaultAmount: Number(cb.dataset.defaultAmount || defaultFee || 200),
                        type: cb.dataset.selType,
                        paymentId: cb.dataset.paymentId || ''
                    });
                    if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                } else {
                    selectedFeeStatusCells.delete(selKey);
                    if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                }
            });
            updateFeeStatusBulkActionButtons();
        });
    });

    // Attach student row checkbox listeners for Fee Status
    cont.querySelectorAll('.fee-status-row-all-cb').forEach(rowCb => {
        rowCb.addEventListener('click', (e) => e.stopPropagation());
        rowCb.addEventListener('change', () => {
            const studentId = rowCb.dataset.studentId;
            const shouldCheck = rowCb.checked;
            const unpaidRowCbs = Array.from(cont.querySelectorAll(`.fee-status-cell-cb[data-student-id="${CSS.escape(studentId)}"][data-sel-type="pay"]`));
            const targetCbs = unpaidRowCbs.length > 0
                ? unpaidRowCbs
                : Array.from(cont.querySelectorAll(`.fee-status-cell-cb[data-student-id="${CSS.escape(studentId)}"]`));

            targetCbs.forEach(cb => {
                cb.checked = shouldCheck;
                const selKey = cb.dataset.selKey;
                const td = cb.closest('td');
                if (shouldCheck) {
                    selectedFeeStatusCells.set(selKey, {
                        studentId: cb.dataset.studentId,
                        itemKey: cb.dataset.itemKey,
                        itemName: cb.dataset.itemName,
                        itemType: cb.dataset.itemType || 'month',
                        defaultAmount: Number(cb.dataset.defaultAmount || defaultFee || 200),
                        type: cb.dataset.selType,
                        paymentId: cb.dataset.paymentId || ''
                    });
                    if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                } else {
                    selectedFeeStatusCells.delete(selKey);
                    if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                }
            });
            updateFeeStatusBulkActionButtons();
        });
    });

    cont.querySelectorAll('.fee-status-cell-cb').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
            const selKey = cb.dataset.selKey;
            const td = cb.closest('td');
            if (cb.checked) {
                selectedFeeStatusCells.set(selKey, {
                    studentId: cb.dataset.studentId,
                    itemKey: cb.dataset.itemKey,
                    itemName: cb.dataset.itemName,
                    itemType: cb.dataset.itemType || 'month',
                    defaultAmount: Number(cb.dataset.defaultAmount || defaultFee || 200),
                    type: cb.dataset.selType,
                    paymentId: cb.dataset.paymentId || ''
                });
                if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
            } else {
                selectedFeeStatusCells.delete(selKey);
                if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
            }
            updateFeeStatusBulkActionButtons();
        });
    });

    updateFeeStatusBulkActionButtons();
};

window.renderFeeTable = renderFeeTable;

// Fee Status table click delegation for interactive cells
document.getElementById('fee-table-container')?.addEventListener('click', (e) => {
    if (e.target.closest('.fee-status-cell-cb') || e.target.closest('.fee-status-col-all-cb') || e.target.closest('.fee-status-row-all-cb')) {
        return;
    }
    const viewCell = e.target.closest('[data-fee-action="view-receipt"]');
    if (viewCell) {
        const paymentId = viewCell.dataset.paymentId;
        const studentId = viewCell.dataset.studentId;
        const itemKey = viewCell.dataset.itemKey;
        let payment = allPayments.find(p => paymentId && p.id === paymentId);
        if (!payment && studentId && itemKey) {
            payment = allPayments.find(p => p.studentId === studentId && p.itemKey === itemKey);
        }
        if (payment) {
            window.openPaymentReceiptDetailModal(payment.id || paymentId, viewCell);
        } else {
            showToast('Receipt details not found.', 'info');
        }
        return;
    }

    const payCell = e.target.closest('[data-fee-action="pay-fee"]');
    if (payCell) {
        const studentId = payCell.dataset.studentId;
        const itemKey = payCell.dataset.itemKey;
        const itemName = payCell.dataset.itemName;
        const defaultAmount = Number(payCell.dataset.defaultAmount || defaultFee || 200);
        const s = getStudentById(studentId);
        if (s) {
            openFeeEntryEditModal({
                source: 'fee-status',
                mode: 'add',
                student: s,
                month: itemName || itemKey,
                itemKey: itemKey,
                itemName: itemName || `${itemKey} Tuition Fee`,
                defaultAmount: defaultAmount,
                targetCellElement: payCell,
                academicYear: selectedFeeAcademicYear || currentWorkingAcademicYear || getAcademicYearFromDate()
            });
        }
        return;
    }
});

// Printable Receipt Slip Generator
export const printPaymentReceiptSlip = (paymentId) => {
    const payment = allPayments.find(p => p.id === paymentId) ||
                    (Array.isArray(window.MasterLedger?.ledgerPayments) ? window.MasterLedger.ledgerPayments.find(p => p.id === paymentId) : null);
    if (!payment) {
        showToast('Receipt details not found for printing.', 'error');
        return;
    }
    const student = getStudentById(payment.studentId) || { name: payment.studentName || 'Student', class: payment.studentClass || payment.classLabel || '-', adm: payment.studentAdm || '-' };
    const collectorName = getStaffName(payment.collectedBy, payment.collectedByName);
    const instName = document.getElementById('header-title')?.textContent?.trim() || 'Noorul Islam Madrasa';
    const place = document.getElementById('header-place')?.textContent?.trim() || '';
    const regNo = document.getElementById('header-regno')?.textContent?.trim() || '';

    const printWindow = window.open('', '_blank', 'width=520,height=680');
    if (!printWindow) {
        window.print();
        return;
    }
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Fee Receipt - #${escapeHtml(payment.receiptNo || 'Slip')}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif; padding: 24px; max-width: 380px; margin: auto; color: #0f172a; line-height: 1.4; }
                .center { text-align: center; }
                .bold { font-weight: 700; }
                .border-b { border-bottom: 1px dashed #cbd5e1; padding-bottom: 12px; margin-bottom: 12px; }
                .border-t { border-top: 1px dashed #cbd5e1; padding-top: 12px; margin-top: 12px; }
                .row { display: flex; justify-content: space-between; margin: 6px 0; font-size: 12px; }
                .title { font-size: 15px; font-weight: 800; text-transform: uppercase; margin-bottom: 3px; }
                .subtitle { font-size: 11px; color: #64748b; margin-bottom: 8px; }
                .amt-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center; margin: 12px 0; }
                .amt { font-size: 20px; font-weight: 800; color: #1d4ed8; }
                .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; background: #dcfce7; color: #166534; font-size: 10px; font-weight: 800; }
                @media print { body { padding: 0; max-width: 100%; } }
            </style>
        </head>
        <body>
            <div class="center border-b">
                <div class="title">${escapeHtml(instName)}</div>
                <div class="subtitle">${escapeHtml(place)} ${regNo ? `• Reg: ${escapeHtml(regNo)}` : ''}</div>
                <div class="badge">OFFICIAL FEE RECEIPT</div>
            </div>
            <div class="row"><span>Receipt No:</span><span class="bold">#${escapeHtml(payment.receiptNo || 'AUTO')}</span></div>
            <div class="row"><span>Date:</span><span>${escapeHtml(payment.paymentDate || new Date().toLocaleDateString('en-GB'))}</span></div>
            <div class="row"><span>Student Name:</span><span class="bold">${escapeHtml(student.name || payment.studentName || '-')}</span></div>
            <div class="row"><span>Class:</span><span>${escapeHtml(student.class || payment.studentClass || '-')}</span></div>
            <div class="row"><span>Admission No:</span><span>${escapeHtml(student.adm || payment.studentAdm || '-')}</span></div>
            <div class="border-t border-b">
                <div class="row bold"><span>Description / Item</span><span>Amount</span></div>
                <div class="row"><span>${escapeHtml(payment.itemName || normalizeFeeItemName(payment.itemKey) || 'Tuition Fee')}</span><span class="bold">₹${Number(payment.amount||0).toFixed(2)}</span></div>
            </div>
            <div class="amt-box">
                <div style="font-size: 11px; color: #64748b; font-weight: 600;">TOTAL AMOUNT PAID</div>
                <div class="amt">₹${Number(payment.amount||0).toFixed(2)}</div>
            </div>
            <div class="row"><span>Payment Mode:</span><span class="bold">${escapeHtml(payment.paymentMode || 'Cash')}</span></div>
            <div class="row"><span>Collected By:</span><span>${escapeHtml(collectorName || 'Staff')}</span></div>
            <div class="center border-t" style="margin-top: 16px; font-size: 10px; color: #94a3b8;">
                Verified Transaction Record • Thank You!
            </div>
            <script>
                window.onload = function() { window.print(); };
            <\/script>
        </body>
        </html>
    `);
    printWindow.document.close();
};

let lastReceiptActiveCell = null;

// Open Verified Receipt Details Modal
window.openPaymentReceiptDetailModal = (paymentId, targetCellElement = null) => {
    if (!paymentId) return;
    lastReceiptActiveCell = targetCellElement || null;
    const payment = allPayments.find(p => p.id === paymentId) ||
                    (Array.isArray(window.MasterLedger?.ledgerPayments) ? window.MasterLedger.ledgerPayments.find(p => p.id === paymentId) : null);
    if (!payment) {
        showToast('Receipt details not found.', 'error');
        return;
    }

    const modal = document.getElementById('payment-receipt-view-modal');
    if (!modal) return;

    const student = getStudentById(payment.studentId) || { name: payment.studentName || 'Student', class: payment.studentClass || payment.classLabel || '-', adm: payment.studentAdm || '-' };
    const collectorName = getStaffName(payment.collectedBy, payment.collectedByName);

    const paymentIdInput = document.getElementById('receipt-view-payment-id');
    if (paymentIdInput) paymentIdInput.value = payment.id || '';

    const studentIdInput = document.getElementById('receipt-view-student-id');
    if (studentIdInput) studentIdInput.value = payment.studentId || '';

    const txnIdInput = document.getElementById('receipt-view-txn-id');
    if (txnIdInput) txnIdInput.value = getPaymentGroupKey(payment) || payment.transactionId || '';

    const rcptEl = document.getElementById('receipt-view-no');
    if (rcptEl) rcptEl.textContent = payment.receiptNo ? `#${payment.receiptNo}` : 'AUTO / N/A';

    const nameEl = document.getElementById('receipt-view-name');
    if (nameEl) nameEl.textContent = student.name || payment.studentName || 'Student';

    const metaEl = document.getElementById('receipt-view-meta');
    if (metaEl) metaEl.textContent = `Class: ${student.class || payment.studentClass || '-'} | Adm: ${student.adm || payment.studentAdm || '-'} | Guardian: ${student.guardian || payment.guardianName || '--'}`;

    const itemEl = document.getElementById('receipt-view-item');
    if (itemEl) itemEl.textContent = payment.itemName || normalizeFeeItemName(payment.itemKey) || 'Fee Payment';

    const amtEl = document.getElementById('receipt-view-amount');
    if (amtEl) amtEl.textContent = `₹${Number(payment.amount || 0).toFixed(0)}`;

    const dateEl = document.getElementById('receipt-view-date');
    if (dateEl) dateEl.textContent = payment.paymentDate ? new Date(payment.paymentDate).toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB');

    const modeEl = document.getElementById('receipt-view-mode');
    if (modeEl) modeEl.textContent = payment.paymentMode || 'Cash';

    const collEl = document.getElementById('receipt-view-collector');
    if (collEl) collEl.textContent = collectorName || 'Staff';

    const descWrap = document.getElementById('receipt-view-desc-wrap');
    const descEl = document.getElementById('receipt-view-desc');
    if (descWrap && descEl) {
        if (payment.description) {
            descEl.textContent = payment.description;
            descWrap.classList.remove('hidden');
        } else {
            descEl.textContent = '';
            descWrap.classList.add('hidden');
        }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

const closePaymentReceiptDetailModal = () => {
    const modal = document.getElementById('payment-receipt-view-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

document.getElementById('receipt-view-close-x')?.addEventListener('click', closePaymentReceiptDetailModal);
document.getElementById('payment-receipt-view-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'payment-receipt-view-modal') closePaymentReceiptDetailModal();
});

document.getElementById('receipt-view-print-btn')?.addEventListener('click', () => {
    const paymentId = document.getElementById('receipt-view-payment-id')?.value;
    if (paymentId) printPaymentReceiptSlip(paymentId);
});

document.getElementById('receipt-view-edit-btn')?.addEventListener('click', () => {
    const paymentId = document.getElementById('receipt-view-payment-id')?.value;
    const studentId = document.getElementById('receipt-view-student-id')?.value;
    const txnId = document.getElementById('receipt-view-txn-id')?.value;
    closePaymentReceiptDetailModal();

    let payment = allPayments.find(p => paymentId && p.id === paymentId) ||
                  (Array.isArray(window.MasterLedger?.ledgerPayments) ? window.MasterLedger.ledgerPayments.find(p => p.id === paymentId) : null);
    if (!payment && studentId && txnId) {
        payment = allPayments.find(p => p.studentId === studentId && (getPaymentGroupKey(p) === txnId || p.transactionId === txnId));
    }

    if (payment) {
        openFeeEntryEditModal({
            mode: 'edit',
            payment: payment,
            targetCellElement: lastReceiptActiveCell,
            academicYear: payment.academicYear || selectedFeeAcademicYear || currentWorkingAcademicYear
        });
    } else if (studentId && txnId) {
        startEditingPayment(studentId, txnId);
    } else {
        showToast('Unable to edit this payment entry.', 'info');
    }
});

document.getElementById('receipt-view-delete-btn')?.addEventListener('click', async () => {
    const paymentId = document.getElementById('receipt-view-payment-id')?.value;
    const txnId = document.getElementById('receipt-view-txn-id')?.value;
    if (!paymentId && !txnId) return;

    if (!confirm('Are you sure you want to permanently delete this payment?')) return;

    try {
        const batch = writeBatch(db);
        let docsToDelete = [];
        if (txnId) {
            docsToDelete = await collectPaymentDocsForGroup(txnId, '');
        }
        if (docsToDelete.length === 0 && paymentId) {
            const singleRef = doc(db, `${BASE_PATH}/payments`, paymentId);
            const singleSnap = await getDoc(singleRef);
            if (singleSnap.exists()) docsToDelete = [singleSnap];
        }

        docsToDelete.forEach((docSnap) => {
            batch.delete(docSnap.ref);
            const payment = docSnap.data();
            const year = payment.academicYear || '';
            if (year) {
                const yearPath = getYearPaymentsCollectionPath(year);
                batch.delete(doc(db, yearPath, docSnap.id));
                batch.delete(doc(db, `${BASE_PATH}/years/${year}/payments`, docSnap.id));
                const cleanYear = String(year).replace(/[^\w-]/g, '_');
                batch.delete(doc(db, `${BASE_PATH}/academicYears/${cleanYear}/payments`, docSnap.id));
            }
        });

        await batch.commit();
        showToast('Payment deleted successfully.', 'success');
        closePaymentReceiptDetailModal();
    } catch (err) {
        console.error('Delete payment error:', err);
        showToast('Failed to delete payment: ' + (err.message || 'Network error'), 'error');
    }
});

const getClassSortValue = (classLabel = '') => {
    const text = String(classLabel || '').toUpperCase();
    const numberMatch = text.match(/\d+/);
    if (numberMatch) return Number(numberMatch[0]);
    if (text.includes('PLUS TWO') || text.includes('+2')) return 12;
    if (text.includes('PLUS ONE') || text.includes('+1')) return 11;
    if (text.includes('UKG')) return 0.2;
    if (text.includes('LKG')) return 0.1;
    return -1;
};
const compareClassesHighToLow = (a = '', b = '') => {
    const rankDiff = getClassSortValue(b) - getClassSortValue(a);
    if (rankDiff !== 0) return rankDiff;
    return String(b || '').localeCompare(String(a || ''), undefined, { numeric: true, sensitivity: 'base' });
};
const studentConcGroupSearchText = (student = {}) => [student.name, student.adm, student.class, student.concessionFee, student.guardian, student.father]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
const groupConcGroupSearchText = (group = {}, members = []) => [
    group.fee,
    group.name,
    ...members.flatMap((member) => [member.name, member.adm, member.class, member.guardian, member.father])
].map((value) => String(value || '').toLowerCase()).join(' ');

let concGroupActiveView = 'concession'; // 'concession' | 'group'

const renderConcessionGroupOverview = () => {
    const yearSelect = document.getElementById('conc-group-year-select');
    const classSelect = document.getElementById('conc-group-class-select');
    const searchInput = document.getElementById('conc-group-search-input');
    const clearSearchBtn = document.getElementById('conc-group-search-clear');
    const viewTabsWrap = document.getElementById('conc-group-view-tabs');

    const selectedYear = yearSelect?.value || currentWorkingAcademicYear || getAcademicYearFromDate();
    if (yearSelect && !yearSelect.dataset.bound) {
        const years = [...new Set(students.map((s) => s.academicYear).filter(Boolean).concat([currentWorkingAcademicYear]).filter(Boolean))].sort(compareAcademicYears);
        yearSelect.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
        yearSelect.value = selectedYear;
        yearSelect.dataset.bound = '1';
        yearSelect.addEventListener('change', () => {
            if (classSelect) delete classSelect.dataset.populatedYear;
            renderConcessionGroupOverview();
        });
    }

    const activeYear = yearSelect?.value || selectedYear;
    const yearStudents = students.filter((student) => (student.academicYear || '') === activeYear);

    if (classSelect && classSelect.dataset.populatedYear !== activeYear) {
        const prevClass = classSelect.value || '';
        const uniqueClasses = [...new Set(yearStudents.map((s) => s.class).filter(Boolean))].sort(compareClassesHighToLow);
        classSelect.innerHTML = `<option value="">All Classes</option>` + uniqueClasses.map((cls) => `<option value="${escapeHtml(cls)}">Class: ${escapeHtml(cls)}</option>`).join('');
        if (prevClass && uniqueClasses.includes(prevClass)) {
            classSelect.value = prevClass;
        }
        classSelect.dataset.populatedYear = activeYear;
        if (!classSelect.dataset.bound) {
            classSelect.dataset.bound = '1';
            classSelect.addEventListener('change', renderConcessionGroupOverview);
        }
    }

    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        searchInput.addEventListener('input', renderConcessionGroupOverview);
    }

    if (clearSearchBtn && !clearSearchBtn.dataset.bound) {
        clearSearchBtn.dataset.bound = '1';
        clearSearchBtn.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            renderConcessionGroupOverview();
        });
    }

    if (viewTabsWrap && !viewTabsWrap.dataset.bound) {
        viewTabsWrap.dataset.bound = '1';
        viewTabsWrap.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-conc-view]');
            if (!btn) return;
            concGroupActiveView = btn.dataset.concView === 'group' ? 'group' : 'concession';
            viewTabsWrap.querySelectorAll('.conc-view-tab-btn').forEach((b) => {
                const isActive = b.dataset.concView === concGroupActiveView;
                b.className = isActive
                    ? 'conc-view-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-blue-700 shadow-xs transition'
                    : 'conc-view-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 hover:text-slate-900 transition';
            });
            renderConcessionGroupOverview();
        });
    }

    const searchTerm = (searchInput?.value || '').trim().toLowerCase();
    const selectedClass = classSelect?.value || '';

    if (clearSearchBtn) {
        clearSearchBtn.classList.toggle('hidden', !searchTerm);
        clearSearchBtn.classList.toggle('inline-flex', Boolean(searchTerm));
    }

    const concessionStudents = yearStudents
        .filter((student) => student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '')
        .filter((student) => !selectedClass || student.class === selectedClass)
        .filter((student) => !searchTerm || studentConcGroupSearchText(student).includes(searchTerm))
        .sort((a, b) => compareClassesHighToLow(a.class, b.class) || String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));

    const groupEntries = studentGroups
        .filter((group) => (group.academicYear || activeYear) === activeYear)
        .map((group) => ({
            group,
            members: (group.memberIds || [])
                .map((memberId) => students.find((student) => student.id === memberId))
                .filter(Boolean)
                .sort((a, b) => compareClassesHighToLow(a.class, b.class) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
        }))
        .filter((entry) => entry.members.length > 0)
        .filter((entry) => !selectedClass || entry.members.some((m) => m.class === selectedClass))
        .filter((entry) => !searchTerm || groupConcGroupSearchText(entry.group, entry.members).includes(searchTerm))
        .sort((a, b) => {
            const topClassA = a.members[0]?.class || '';
            const topClassB = b.members[0]?.class || '';
            return compareClassesHighToLow(topClassA, topClassB)
                || String(a.members[0]?.name || '').localeCompare(String(b.members[0]?.name || ''), undefined, { sensitivity: 'base' });
        });

    const totalGroupedStudentsCount = groupEntries.reduce((sum, entry) => sum + entry.members.length, 0);

    const summaryEl = document.getElementById('conc-group-summary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="bg-emerald-50/80 border border-emerald-200 rounded-xl p-3.5 flex items-center justify-between">
                <div>
                    <div class="text-[11px] uppercase font-extrabold text-emerald-700 tracking-wide">Concession Students</div>
                    <div class="text-2xl font-black text-emerald-900 mt-0.5">${concessionStudents.length}</div>
                </div>
                <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center text-lg"><i class="fas fa-percent"></i></div>
            </div>
            <div class="bg-blue-50/80 border border-blue-200 rounded-xl p-3.5 flex items-center justify-between">
                <div>
                    <div class="text-[11px] uppercase font-extrabold text-blue-700 tracking-wide">Concession Groups</div>
                    <div class="text-2xl font-black text-blue-900 mt-0.5">${groupEntries.length}</div>
                </div>
                <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center text-lg"><i class="fas fa-users"></i></div>
            </div>
            <div class="bg-indigo-50/80 border border-indigo-200 rounded-xl p-3.5 flex items-center justify-between">
                <div>
                    <div class="text-[11px] uppercase font-extrabold text-indigo-700 tracking-wide">Students in Groups</div>
                    <div class="text-2xl font-black text-indigo-900 mt-0.5">${totalGroupedStudentsCount}</div>
                </div>
                <div class="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center text-lg"><i class="fas fa-user-friends"></i></div>
            </div>
        `;
    }

    const emptyConcLabel = searchTerm || selectedClass ? 'No matching concession students found.' : 'No concession students configured for this academic year.';
    const emptyGroupLabel = searchTerm || selectedClass ? 'No matching groups found.' : 'No concession groups configured for this academic year.';

    // Build Concession Table HTML
    const concessionTableHtml = `
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs flex flex-col">
            <div class="px-4 py-3 bg-emerald-50/70 border-b border-emerald-200 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="w-6 h-6 rounded-lg bg-emerald-600 text-white inline-flex items-center justify-center text-xs"><i class="fas fa-user-tag"></i></span>
                    <h3 class="font-extrabold text-slate-800 text-sm">Individual Concession Table</h3>
                </div>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200">${concessionStudents.length} Students</span>
            </div>
            <div class="overflow-x-auto custom-scroll max-h-[68vh]">
                ${concessionStudents.length > 0 ? `
                <table class="w-full text-xs text-left border-collapse">
                    <thead class="bg-slate-100 text-slate-700 uppercase font-extrabold sticky top-0 z-10 border-b border-slate-200 shadow-2xs">
                        <tr>
                            <th class="py-2.5 px-3 w-12 text-center border-r border-slate-200">#</th>
                            <th class="py-2.5 px-3 w-24 border-r border-slate-200">Adm No</th>
                            <th class="py-2.5 px-3 border-r border-slate-200 min-w-[170px]">Student Name</th>
                            <th class="py-2.5 px-3 w-20 text-center border-r border-slate-200">Class</th>
                            <th class="py-2.5 px-3 w-28 text-right">Concession Fee</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                        ${concessionStudents.map((student, idx) => {
                            const guardian = student.guardian || student.father || '';
                            const normalFeeVal = Number(defaultFee || 200);
                            const concFeeVal = Number(student.concessionFee || 0);
                            const discountVal = normalFeeVal > concFeeVal ? normalFeeVal - concFeeVal : 0;
                            return `
                            <tr class="hover:bg-emerald-50/40 transition cursor-pointer" onclick="window.openStudentProfile && window.openStudentProfile('${escapeHtml(student.id)}')" title="Click to view profile">
                                <td class="py-2.5 px-3 text-center font-mono font-bold text-slate-400 border-r border-slate-100">${idx + 1}</td>
                                <td class="py-2.5 px-3 font-mono font-bold text-slate-700 border-r border-slate-100 whitespace-nowrap">${escapeHtml(student.adm || '-')}</td>
                                <td class="py-2.5 px-3 border-r border-slate-100">
                                    <div class="font-bold text-slate-900 leading-snug">${escapeHtml(student.name || '--')}</div>
                                    ${guardian ? `<div class="text-[10px] text-slate-500 mt-0.5 truncate max-w-[220px]"><i class="fas fa-user-shield text-[9px] mr-1 text-slate-400"></i>${escapeHtml(guardian)}</div>` : ''}
                                </td>
                                <td class="py-2.5 px-3 text-center border-r border-slate-100 whitespace-nowrap">
                                    <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 font-bold text-[11px] border border-slate-200">${escapeHtml(student.class || '--')}</span>
                                </td>
                                <td class="py-2.5 px-3 text-right whitespace-nowrap">
                                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-900 font-mono font-extrabold text-xs border border-emerald-200">
                                        ₹${escapeHtml(String(student.concessionFee))}/mo
                                    </span>
                                    ${discountVal > 0 ? `<div class="text-[9px] font-semibold text-emerald-600 mt-0.5">Saves ₹${discountVal}/mo</div>` : ''}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
                ` : `<div class="p-8 text-center text-xs font-semibold text-slate-400">${emptyConcLabel}</div>`}
            </div>
        </div>
    `;

    // Build Group List Table HTML
    const groupTableHtml = `
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs flex flex-col">
            <div class="px-4 py-3 bg-blue-50/70 border-b border-blue-200 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="w-6 h-6 rounded-lg bg-blue-600 text-white inline-flex items-center justify-center text-xs"><i class="fas fa-users"></i></span>
                    <h3 class="font-extrabold text-slate-800 text-sm">Concession Group Table (Family / Siblings)</h3>
                </div>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-blue-100 text-blue-800 border border-blue-200">${groupEntries.length} Groups</span>
            </div>
            <div class="overflow-x-auto custom-scroll max-h-[68vh]">
                ${groupEntries.length > 0 ? `
                <table class="w-full text-xs text-left border-collapse">
                    <thead class="bg-slate-100 text-slate-700 uppercase font-extrabold sticky top-0 z-10 border-b border-slate-200 shadow-2xs">
                        <tr>
                            <th class="py-2.5 px-3 w-24 text-center border-r border-slate-200">Group #</th>
                            <th class="py-2.5 px-3 border-r border-slate-200 min-w-[260px]">Group Members (Students)</th>
                            <th class="py-2.5 px-3 w-32 text-right">Group Fee</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-200">
                        ${groupEntries.map(({ group, members }, idx) => {
                            const primaryGuardian = members.map((m) => m.guardian || m.father).find(Boolean) || '';
                            const groupFeeDisplay = group.fee ? `₹${escapeHtml(String(group.fee))}/mo` : `₹${escapeHtml(String(defaultFee || 200))}/mo`;

                            const membersSubRows = members.map((member, mIdx) => `
                                <div class="flex items-center justify-between gap-2 py-1.5 ${mIdx > 0 ? 'border-t border-slate-100' : ''} hover:bg-blue-50/50 px-1.5 rounded transition cursor-pointer"
                                     onclick="window.openStudentProfile && window.openStudentProfile('${escapeHtml(member.id)}')"
                                     title="Click to view ${escapeHtml(member.name || 'student')} profile">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <span class="w-4 h-4 rounded-full bg-blue-100 text-blue-700 font-mono text-[10px] font-bold inline-flex items-center justify-center flex-shrink-0">${mIdx + 1}</span>
                                        <span class="font-bold text-slate-900 truncate">${escapeHtml(member.name || '--')}</span>
                                    </div>
                                    <div class="flex items-center gap-1.5 flex-shrink-0">
                                        <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[10px] font-bold border border-slate-200">Adm: ${escapeHtml(member.adm || '-')}</span>
                                        <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold text-[10px] border border-blue-200">Cls: ${escapeHtml(member.class || '-')}</span>
                                    </div>
                                </div>
                            `).join('');

                            return `
                            <tr class="hover:bg-slate-50/70 transition align-top">
                                <td class="py-3 px-3 text-center border-r border-slate-100 whitespace-nowrap">
                                    <div class="inline-flex flex-col items-center">
                                        <span class="px-2.5 py-1 rounded-lg bg-blue-600 text-white font-extrabold text-[11px] shadow-2xs">Group ${idx + 1}</span>
                                        <span class="text-[10px] font-bold text-slate-500 mt-1">${members.length} ${members.length === 1 ? 'Child' : 'Children'}</span>
                                    </div>
                                </td>
                                <td class="py-2 px-3 border-r border-slate-100">
                                    ${primaryGuardian ? `<div class="text-[10px] font-bold text-slate-500 mb-1 px-1.5 flex items-center gap-1"><i class="fas fa-house-user text-blue-500"></i> Guardian: <span class="text-slate-700">${escapeHtml(primaryGuardian)}</span></div>` : ''}
                                    <div class="divide-y divide-slate-100">${membersSubRows}</div>
                                </td>
                                <td class="py-3 px-3 text-right whitespace-nowrap">
                                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg bg-blue-100 text-blue-900 font-mono font-extrabold text-xs border border-blue-200">
                                        ${groupFeeDisplay}
                                    </span>
                                    <div class="text-[10px] font-semibold text-slate-500 mt-1">Combined Rate</div>
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
                ` : `<div class="p-8 text-center text-xs font-semibold text-slate-400">${emptyGroupLabel}</div>`}
            </div>
        </div>
    `;

    const contentEl = document.getElementById('conc-group-content');
    if (contentEl) {
        if (concGroupActiveView === 'group') {
            contentEl.innerHTML = `<div class="grid grid-cols-1 gap-5">${groupTableHtml}</div>`;
        } else {
            contentEl.innerHTML = `<div class="grid grid-cols-1 gap-5">${concessionTableHtml}</div>`;
        }
    }
};
// --- HISTORY RENDER ---
const updateHistoryStaffFilter = () => {
    const filterEl = document.getElementById('history-staff-filter');
    if (!isCurrentAdmin) { filterEl.classList.add('hidden'); return; }
    filterEl.classList.remove('hidden');

    const uniqueEmails = [...new Set(allPayments.map(p => p.collectedBy))].filter(Boolean);
    const currentVal = filterEl.value;

    let opts = `<option value="all">All Staff Collections</option>`;
    uniqueEmails.forEach(email => { opts += `<option value="${email}">${getStaffName(email, null)}</option>`; });

    filterEl.innerHTML = opts;
    if(uniqueEmails.includes(currentVal) || currentVal === 'all') filterEl.value = currentVal;
};

const prepareHistoryData = () => {
    historyRenderToken += 1;
    if (historyLoadTimer) {
        clearTimeout(historyLoadTimer);
        historyLoadTimer = null;
    }

    let myPays = isCurrentAdmin ? [...allPayments] : allPayments.filter((payment) => isSameCollectorRecord(payment.collectedBy));
    let myDonations = isCurrentAdmin ? [...allDonations] : allDonations.filter((donation) => isSameCollectorRecord(donation.collectedBy));

    if (isCurrentAdmin) {
        const staffFilter = document.getElementById('history-staff-filter').value;
        if (staffFilter && staffFilter !== 'all') {
            myPays = myPays.filter(p => p.collectedBy === staffFilter);
            myDonations = myDonations.filter((donation) => donation.collectedBy === staffFilter);
        }
    }

    const searchTerm = document.getElementById('history-search-input').value.toLowerCase();

    // 🌟 FIX: Timestamp History Sorting 🌟
    const feeHistoryGroups = Object.values(myPays.reduce((a, p) => {
        const k = getPaymentGroupKey(p);
        
        // Use exact millisecond timestamp from database
        const pTs = p.timestamp || new Date(p.paymentDate || Date.now()).getTime();
        
        if(!a[k]) {
            a[k] = {
                tId: k, r: p.receiptNo||'-', sId: p.studentId, dt: p.paymentDate,
                ts: pTs, kind: 'fee',
                i: [], tot: 0, by: getStaffName(p.collectedBy, p.collectedByName), studentIds: [], seenBillingKeys: new Set()
            };
        } else {
            // Keep the absolute highest (newest) timestamp for accurate sorting of this group
            if (pTs > a[k].ts) a[k].ts = pTs;
        }
        
        const billingKey = getPaymentBillingKey(p);
        if (!a[k].seenBillingKeys.has(billingKey)) {
            a[k].seenBillingKeys.add(billingKey);
            a[k].i.push(p.itemKey);
            a[k].tot = roundMoney(a[k].tot + getMonthlyReportPaymentAmount(p));
        }
        
        if (!a[k].studentIds.includes(p.studentId)) a[k].studentIds.push(p.studentId);
        
        return a;
    }, {}));
    
    const donationHistoryRows = myDonations.map((donation) => ({
        tId: `donation:${donation.id}`,
        r: donation.receiptNo || '-',
        sId: '',
        dt: donation.paymentDate,
        ts: donation.timestamp || new Date(donation.paymentDate || Date.now()).getTime(),
        kind: 'donation',
        i: ['donation'],
        tot: Number(donation.amount || 0),
        by: getStaffName(donation.collectedBy, donation.collectedByName),
        studentIds: [],
        donorName: donation.donorName || '-',
        description: donation.description || ''
    }));
    sortedHistoryList = [...feeHistoryGroups, ...donationHistoryRows];

    if (searchTerm) {
        sortedHistoryList = sortedHistoryList.filter(item => {
            if (item.kind === 'donation') {
                const donor = (item.donorName || '').toLowerCase();
                const desc = (item.description || '').toLowerCase();
                const rNo = item.r.toString().toLowerCase();
                return donor.includes(searchTerm) || desc.includes(searchTerm) || rNo.includes(searchTerm);
            }
            const studentsInTxn = item.studentIds.map((id) => getStudentById(id)).filter(Boolean);
            const sName = studentsInTxn.map((student) => student.name.toLowerCase()).join(' ');
            const sAdm = studentsInTxn.map((student) => (student.adm || '').toLowerCase()).join(' ');
            const rNo = item.r.toString().toLowerCase();
            return sName.includes(searchTerm) || sAdm.includes(searchTerm) || rNo.includes(searchTerm);
        });
    }

    // Sort by entered payment date first (desc), then by timestamp within same date (desc)
    const toDayValue = (dateStr = '') => {
        if (!dateStr) return 0;
        const parsed = new Date(`${dateStr}T00:00:00`).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
    };
    sortedHistoryList.sort((a, b) => {
        const dayDiff = toDayValue(b.dt) - toDayValue(a.dt);
        if (dayDiff !== 0) return dayDiff;
        return Number(b.ts || 0) - Number(a.ts || 0);
    });

    document.getElementById('history-count-badge').textContent = `${sortedHistoryList.length} Transactions`;
    const tbody = document.getElementById('history-content-tbody');
    document.getElementById('history-loading-indicator').classList.add('hidden');
    if(sortedHistoryList.length === 0) {
        historyDisplayedCount = 0;
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-gray-500">No payment history found.</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    historyDisplayedCount = 0;
    loadMoreHistory(historyRenderToken);
};

document.getElementById('history-staff-filter').addEventListener('change', prepareHistoryData);
document.getElementById('history-search-input').addEventListener('input', prepareHistoryData);

const loadMoreHistory = (renderToken = historyRenderToken) => {
    if(historyDisplayedCount >= sortedHistoryList.length) return;

    const limit = historyDisplayedCount === 0 ? INITIAL_LOAD : LOAD_MORE;
    const toAdd = sortedHistoryList.slice(historyDisplayedCount, historyDisplayedCount + limit);
    const tbody = document.getElementById('history-content-tbody');
    const loader = document.getElementById('history-loading-indicator');

    loader.classList.remove('hidden');

    historyLoadTimer = setTimeout(() => {
        if (renderToken !== historyRenderToken) {
            loader.classList.add('hidden');
            return;
        }
        let html = '';
        toAdd.forEach(i => {
            const seenStudentIds = new Set();
            const txnStudents = i.studentIds
                .filter((id) => {
                    if (!id || seenStudentIds.has(id)) return false;
                    seenStudentIds.add(id);
                    return true;
                })
                .map((id) => getStudentById(id))
                .filter(Boolean);
            const primaryStudent = txnStudents[0] || getStudentById(i.sId);
            const isDonationRow = i.kind === 'donation';
            if(!primaryStudent && !isDonationRow) return;
            const formatStudentMeta = (student) => `${student.name} (Adm: ${student.adm||'-'}, Class: ${student.class||'-'})`;
            const primaryStudentLabel = isDonationRow
                ? `Donation: ${i.donorName || '-'}${i.description ? ` (${i.description})` : ''}`
                : formatStudentMeta(primaryStudent);
            const otherStudentRows = txnStudents.slice(1).map((student) => formatStudentMeta(student));
            const studentCount = isDonationRow ? 1 : (txnStudents.length || 1);
            const totalLabel = `₹${Number(i.tot || 0).toFixed(0)} (${studentCount})`;
            html += `<tr class="bg-white hover:bg-gray-50 transition">
                <td class="p-3 font-medium text-gray-900">${i.r}</td>
                <td class="p-3 text-gray-600">${new Date(i.dt).toLocaleDateString('en-GB')}</td>
                <td class="p-3 font-medium text-blue-700">${escapeHtml(primaryStudentLabel)}${otherStudentRows.length ? `<span class="text-[10px] text-gray-500 block mt-1">${otherStudentRows.map((row) => escapeHtml(row)).join('<br>')}</span>` : ''}</td>
                <td class="p-3"><span class="text-[10px] font-bold uppercase tracking-wider bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-100 whitespace-nowrap">${i.by}</span></td>
                <td class="p-3 text-center text-gray-600">${isDonationRow ? 'Donation' : i.i.length}</td>
                <td class="p-3 font-bold text-gray-800">${totalLabel}</td>
                <td class="p-3 text-center">${isDonationRow
                    ? `<button class="donation-edit-btn text-blue-500 hover:text-blue-700 mr-3" data-id="${i.tId.replace('donation:', '')}"><i class="fas fa-edit"></i></button><button class="donation-del-btn text-red-500 hover:text-red-700" data-id="${i.tId.replace('donation:', '')}"><i class="fas fa-trash"></i></button>`
                    : `<button class="edit-payment-btn text-blue-500 hover:text-blue-700 mr-3" data-sid="${i.sId}" data-tid="${i.tId}"><i class="fas fa-edit"></i></button><button class="delete-payment-btn text-red-500 hover:text-red-700" data-sid="${i.sId}" data-tid="${i.tId}"><i class="fas fa-trash"></i></button>`}</td>
            </tr>`;
        });
        tbody.insertAdjacentHTML('beforeend', html);
        historyDisplayedCount += toAdd.length;
        loader.classList.add('hidden');
        historyLoadTimer = null;
    }, 300);
};

document.getElementById('history-content-container').addEventListener('scroll', function() {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 20) {
        if (historyDisplayedCount < sortedHistoryList.length) { loadMoreHistory(); }
    }
});

// Event Delegation for dynamically generated history buttons
document.getElementById('history-content-container').addEventListener('click', e => {
    const editBtn = e.target.closest('.edit-payment-btn'), delBtn = e.target.closest('.delete-payment-btn');
    const donationEditBtn = e.target.closest('.donation-edit-btn');
    const donationDelBtn = e.target.closest('.donation-del-btn');
    if(editBtn) startEditingPayment(editBtn.dataset.sid, editBtn.dataset.tid);
    if (donationEditBtn) {
        const donation = allDonations.find((entry) => entry.id === donationEditBtn.dataset.id);
        if (!donation) return;
        editingDonationId = donation.id;
        document.getElementById('donation-name').value = donation.donorName || '';
        document.getElementById('donation-receipt').value = donation.receiptNo || '';
        document.getElementById('donation-amount').value = donation.amount || '';
        document.getElementById('donation-date').value = donation.paymentDate || new Date().toISOString().split('T')[0];
        document.getElementById('donation-description').value = donation.description || '';
        setupDonationEntryUI();
        document.querySelector('.nav-link[data-target="donation-page"]')?.click();
    }
    if (donationDelBtn) {
        if (!confirm('Delete this donation entry?')) return;
        deleteDoc(doc(db, `${BASE_PATH}/donations`, donationDelBtn.dataset.id)).catch((error) => {
            console.error(error);
            alert('Failed to delete donation.');
        });
    }
    if(delBtn) {
        const tid = delBtn.dataset.tid;
        document.getElementById('confirm-title').textContent = "Delete Payment";
        document.getElementById('confirm-message').innerHTML = `<p class="text-gray-800 font-medium">Are you sure you want to permanently delete this payment?</p>`;
        document.getElementById('confirm-popup').classList.remove('hidden');
        document.getElementById('confirm-popup').classList.add('flex');

        document.getElementById('confirm-ok').onclick = async () => {
            const batch = writeBatch(db);
            const docsToDelete = await collectPaymentDocsForGroup(tid, '');
            docsToDelete.forEach((docSnap) => {
                batch.delete(docSnap.ref);
                const payment = docSnap.data();
                const yearPath = getYearPaymentsCollectionPath(payment.academicYear || '');
                batch.delete(doc(db, yearPath, docSnap.id));
            });
            await batch.commit(); document.getElementById('confirm-popup').classList.add('hidden');
        }
    }
});

// --- MONTHLY REPORT RENDER ---
const renderMonthlyCollectedPage = (searchTerm = '') => {
    const cont = document.getElementById('monthly-collected-container'), lowerTerm = searchTerm.toLowerCase(); cont.innerHTML = '';
    const myPays = getVisiblePayments();
    const myDonations = getVisibleDonations();
    const combinedEntries = [...myPays, ...myDonations];
    renderMonthlySummaryCards(combinedEntries.filter((payment) => {
        if (!searchTerm) return true;
        if (payment.entryType === 'donation') {
            return (payment.donorName || '').toLowerCase().includes(lowerTerm)
                || (payment.description || '').toLowerCase().includes(lowerTerm)
                || (payment.receiptNo && payment.receiptNo.toString().includes(lowerTerm));
        }
        const student = getStudentById(payment.studentId);
        return Boolean(student) && (
            student.name.toLowerCase().includes(lowerTerm) ||
            (student.adm && student.adm.toLowerCase().includes(lowerTerm)) ||
            student.class.toLowerCase().includes(lowerTerm) ||
            (payment.receiptNo && payment.receiptNo.toString().includes(lowerTerm))
        );
    }), searchTerm);

    if (searchTerm) {
        const matching = students.filter(s => s.name.toLowerCase().includes(lowerTerm) || (s.adm && s.adm.toLowerCase().includes(lowerTerm)));
        if (matching.length === 1) {
            const s = matching[0], paysByItem = myPays.filter(p => p.studentId === s.id).reduce((acc, p) => { acc[p.itemKey] = p; return acc; }, {});
            let reportText = `NAME   : ${s.name.toUpperCase()}\nCLASS  : ${s.class}\nADM NO : ${s.adm||'-'}\n`;
            let mText = '', cText = '';
            feeItems.forEach(i => { const p = paysByItem[i.key]; if (p) { const rStr = p.receiptNo ? p.receiptNo.toString().padEnd(6,' ') : '-     '; if (i.type === 'month') mText += `RCPT : ${rStr} | ${normalizeFeeItemName(i.name)}\n`; else cText += `RCPT : ${rStr} | ${normalizeFeeItemName(i.name)} (₹${p.amount})\n`; } });
            if (mText) reportText += `\n--- MONTHS ---\n${mText}`; if (cText) reportText += `\n--- OTHER FEES ---\n${cText}`; if (!mText && !cText) reportText += `\nNo data.\n`;
            cont.innerHTML = `<div class="report-card whitespace-pre-wrap text-sm md:text-base bg-gray-50 border border-gray-200 p-4 rounded-xl"><div class="flex justify-between items-start border-b pb-3 mb-3"><h3 class="text-lg font-bold">Student Report</h3><button id="back-to-monthly-view-btn" class="py-1 px-3 bg-gray-200 rounded-lg text-sm font-semibold">Back</button></div><pre class="font-mono">${escapeHtml(reportText)}</pre></div><div class="mt-5 text-center"><button id="share-whatsapp-btn-monthly" data-share-text="${encodeURIComponent('*Student Payment Report*\n-----------------------\n'+reportText)}" class="inline-flex items-center gap-2 bg-green-500 hover:bg-green-600 transition text-white font-bold py-3 px-6 rounded-xl shadow-md w-full md:w-auto justify-center"><i class="fab fa-whatsapp text-xl"></i> <span>Share on WhatsApp</span></button></div>`; return;
        } else if (matching.length > 1) {
            cont.innerHTML = `<div class="p-4 bg-gray-50 border rounded-xl"><h3 class="font-bold text-lg mb-1">Search Results</h3><p class="text-sm text-gray-500 mb-4">Click to view report</p><ul class="space-y-2">${matching.map(s => `<li><button class="w-full text-left p-3 rounded-lg bg-white border hover:border-blue-400 font-medium monthly-student-select flex justify-between" data-student-name="${escapeHtml(s.name)}"><span>${escapeHtml(s.name)} <span class="text-gray-500 text-sm font-normal">(${escapeHtml(s.class)})</span></span><span class="text-xs text-gray-400 font-mono">Adm: ${escapeHtml(s.adm||'-')}</span></button></li>`).join('')}</ul></div>`; return;
        }
    }

    const pays = searchTerm
        ? combinedEntries.filter((entry) => {
            if (entry.entryType === 'donation') {
                return (entry.donorName || '').toLowerCase().includes(lowerTerm)
                    || (entry.description || '').toLowerCase().includes(lowerTerm)
                    || (entry.receiptNo && entry.receiptNo.toString().includes(lowerTerm));
            }
            const student = getStudentById(entry.studentId);
            return student && (student.class.toLowerCase().includes(lowerTerm) || (entry.receiptNo && entry.receiptNo.toString().includes(lowerTerm)));
        })
        : combinedEntries;
    const sortedKeys = Object.keys(pays.reduce((a, p) => { if (p.paymentDate) { const mk = p.paymentDate.substring(0, 7); if (!a[mk]) a[mk] = []; a[mk].push(p); } return a; }, {})).sort().reverse();
    if (sortedKeys.length === 0) { cont.innerHTML = buildEmptyState('No monthly report data found for the selected filter.', 'fa-chart-column'); return; }

    const currentMK = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const receiptSort = (a, b) => {
        const aNum = Number(a?.receiptNo ?? a ?? 0);
        const bNum = Number(b?.receiptNo ?? b ?? 0);
        const aValid = Number.isFinite(aNum);
        const bValid = Number.isFinite(bNum);
        if (aValid && bValid) return aNum - bNum;
        if (aValid) return -1;
        if (bValid) return 1;
        return String(a?.receiptNo ?? a ?? '').localeCompare(String(b?.receiptNo ?? b ?? ''), undefined, { numeric: true });
    };

    sortedKeys.forEach(mk => {
        const monthPays = pays.filter(p => p.paymentDate.substring(0,7) === mk), uTxns = {};
        monthPays.forEach(p => {
            const tid = p.transactionId || p.receiptNo;
            if (!uTxns[tid]) {
                const pt = monthPays.filter(pay => (pay.transactionId || pay.receiptNo) === tid);
                const m = sumReportPaymentsOnce(pt, (pay) => getPaymentItemType(pay) === 'month');
                const c = sumReportPaymentsOnce(pt, (pay) => getPaymentItemType(pay) === 'custom');
                uTxns[tid] = { m, c };
            }
        });
        const mTot = Object.values(uTxns).reduce((s, d) => s + d.m, 0);
        const cTot = Object.values(uTxns).reduce((s, d) => s + d.c, 0);
        const donationPays = monthPays.filter((entry) => entry.entryType === 'donation');
        const feePays = monthPays.filter((entry) => entry.entryType !== 'donation');
        const mF = feePays.filter((p) => getPaymentItemType(p) === 'month');
        const studentDonationPays = feePays.filter((p) => p.itemKey === STUDENT_DONATION_ITEM_KEY);
        const cF = feePays.filter((p) => getPaymentItemType(p) === 'custom' && p.itemKey !== STUDENT_DONATION_ITEM_KEY);
        const defaultTotal = roundMoney(mTot);
        const donationTotal = roundMoney(donationPays.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
            + studentDonationPays.reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
        const otherTotal = roundMoney(cTot);
        const grandTotal = roundMoney(defaultTotal + donationTotal + otherTotal);

        let html = `<div class="bg-gray-50 border p-4 rounded-xl"><div class="flex flex-col md:flex-row md:justify-between md:items-center gap-3 cursor-pointer month-header"><div><h3 class="text-base font-bold">${formatMonthLabel(mk)}</h3><p class="text-xs text-gray-500 font-medium mt-1">${Object.keys(uTxns).length} receipt groups • ${new Set(monthPays.map((payment) => payment.studentId)).size} students</p></div><div class="flex flex-wrap items-center gap-2 text-[11px] font-bold"><span class="bg-white px-2 py-1 rounded border">Default: ${formatCurrency(defaultTotal)}</span><span class="bg-emerald-50 text-emerald-700 px-2 py-1 rounded border border-emerald-200">Donation: ${formatCurrency(donationTotal)}</span><span class="bg-amber-50 text-amber-700 px-2 py-1 rounded border border-amber-200">Other: ${formatCurrency(otherTotal)}</span><span class="bg-indigo-50 text-indigo-700 px-2 py-1 rounded border border-indigo-200">Total: ${formatCurrency(grandTotal)}</span><i class="fas fa-chevron-down month-toggle-icon text-gray-400 ${mk === currentMK ? 'rotate-180' : ''} transition ml-1"></i></div></div><div class="month-details-container overflow-x-auto mt-4 pt-4 border-t ${mk === currentMK ? '' : 'hidden'}">`;
        if (mF.length > 0) {
            const monthlyTxnRows = Object.values(mF.reduce((acc, payment) => {
                const txnKey = payment.transactionId || payment.receiptNo || `tx-${payment.timestamp || Math.random()}`;
                if (!acc[txnKey]) acc[txnKey] = { receiptNo: payment.receiptNo || '-', total: 0, students: {}, seenBilling: new Set() };
                const billingKey = payment.billingGroupId
                    ? `${txnKey}__${payment.itemKey || ''}__${payment.academicYear || ''}__${payment.billingGroupId}`
                    : '';
                if (!(billingKey && acc[txnKey].seenBilling.has(billingKey))) {
                    acc[txnKey].total = roundMoney(acc[txnKey].total + getMonthlyReportPaymentAmount(payment));
                    if (billingKey) acc[txnKey].seenBilling.add(billingKey);
                }
                const student = getStudentById(payment.studentId) || {};
                acc[txnKey].students[payment.studentId || txnKey] = {
                    name: student.name || 'Unknown',
                    class: student.class || '-',
                    adm: student.adm || '-'
                };
                return acc;
            }, {})).sort(receiptSort);
            html += `<table class="w-full text-sm text-left mb-4"><thead class="bg-gray-100"><tr><th class="p-2">Rcpt</th><th class="p-2">Students</th><th class="p-2">Amount</th></tr></thead><tbody>${monthlyTxnRows.map((row) => {
                const studentLines = Object.values(row.students).map((student) => `<div class="leading-tight">${escapeHtml(student.name)} <span class="text-[11px] text-gray-500">(${escapeHtml(student.class)} · Adm: ${escapeHtml(student.adm)})</span></div>`).join('');
                return `<tr class="border-b hover:bg-white align-top"><td class="p-2">${row.receiptNo}</td><td class="p-2">${studentLines}</td><td class="p-2 font-semibold">₹${row.total.toFixed(0)}</td></tr>`;
            }).join('')}</tbody></table>`;
        }
        const sortedCustomFees = [...cF].sort(receiptSort);
        if (sortedCustomFees.length > 0) html += `<h4 class="text-sm font-bold mt-4 mb-2 bg-gray-200 inline-block px-3 py-1 rounded-lg">Other Fees</h4><table class="w-full text-sm text-left whitespace-nowrap"><thead class="bg-gray-100"><tr><th class="p-2">Rcpt</th><th class="p-2">Student</th><th class="p-2">Item</th><th class="p-2">Amount</th></tr></thead><tbody>` + sortedCustomFees.map(p => `<tr class="border-b hover:bg-white"><td class="p-2">${p.receiptNo||'-'}</td><td class="p-2">${getStudentById(p.studentId)?.name||'Unknown'}</td><td class="p-2">${normalizeFeeItemName(feeItems.find(fi => fi.key === p.itemKey)?.name||p.itemKey)}</td><td class="p-2 font-semibold">₹${Number(p.amount || 0).toFixed(0)}</td></tr>`).join('') + `</tbody><tfoot class="font-bold border-t"><tr><td colspan="3" class="p-2 text-right">Total</td><td class="p-2 text-green-700">₹${otherTotal.toFixed(0)}</td></tr></tfoot></table>`;
        if (donationPays.length > 0 || studentDonationPays.length > 0) {
            const donationRows = [
                ...donationPays.map((entry) => ({
                    receiptNo: entry.receiptNo || '-',
                    name: entry.donorName || '-',
                    description: entry.description || '-',
                    amount: Number(entry.amount || 0),
                    by: getStaffName(entry.collectedBy, entry.collectedByName)
                })),
                ...studentDonationPays.map((entry) => {
                    const student = getStudentById(entry.studentId) || {};
                    return {
                        receiptNo: entry.receiptNo || '-',
                        name: student.name ? `${student.name} (Student)` : 'Student Donation',
                        description: `Class: ${student.class || '-'} · Adm: ${student.adm || '-'}`,
                        amount: Number(entry.amount || 0),
                        by: getStaffName(entry.collectedBy, entry.collectedByName)
                    };
                })
            ];
            const sortedDonationRows = donationRows.sort(receiptSort);
            html += `<h4 class="text-sm font-bold mt-4 mb-2 bg-emerald-100 text-emerald-700 inline-block px-3 py-1 rounded-lg">Donation</h4><table class="w-full text-sm text-left whitespace-nowrap"><thead class="bg-emerald-50"><tr><th class="p-2">Rcpt</th><th class="p-2">Name</th><th class="p-2">Description</th><th class="p-2">Amount</th><th class="p-2">Collected By</th></tr></thead><tbody>${sortedDonationRows.map((entry) => `<tr class="border-b hover:bg-white"><td class="p-2">${entry.receiptNo}</td><td class="p-2">${escapeHtml(entry.name)}</td><td class="p-2">${escapeHtml(entry.description)}</td><td class="p-2 font-semibold">₹${entry.amount.toFixed(0)}</td><td class="p-2">${escapeHtml(entry.by)}</td></tr>`).join('')}</tbody><tfoot class="font-bold border-t"><tr><td colspan="3" class="p-2 text-right">Donation Total</td><td class="p-2 text-emerald-700">₹${donationTotal.toFixed(0)}</td><td></td></tr></tfoot></table>`;
        }
        cont.innerHTML += html + `</div></div>`;
    });
};
document.getElementById('monthly-collected-search-input').addEventListener('input', e => renderMonthlyCollectedPage(e.target.value));
document.getElementById('monthly-report-download-btn').addEventListener('click', () => exportMonthlySummaryCsv(document.getElementById('monthly-collected-search-input').value));
document.getElementById('monthly-collected-container').addEventListener('click', e => {
    const h = e.target.closest('.month-header'), sel = e.target.closest('.monthly-student-select'), back = e.target.closest('#back-to-monthly-view-btn'), share = e.target.closest('#share-whatsapp-btn-monthly');
    if(h) { h.nextElementSibling.classList.toggle('hidden'); h.querySelector('.month-toggle-icon').classList.toggle('rotate-180'); }
    else if(sel) { document.getElementById('monthly-collected-search-input').value = sel.dataset.studentName; renderMonthlyCollectedPage(sel.dataset.studentName); }
    else if(back) { document.getElementById('monthly-collected-search-input').value = ''; renderMonthlyCollectedPage(''); }
    else if(share) window.open(`https://wa.me/?text=${share.dataset.shareText}`, '_blank');
});

const renderCollectorWiseMonthlyPage = () => {
    const container = document.getElementById('collector-wise-monthly-container');
    if (!container) return;
    if (!isCurrentAdmin) {
        container.innerHTML = `<div class="text-sm text-gray-500 bg-gray-50 border rounded-xl p-4">Admin access required.</div>`;
        return;
    }
    const groupedByMonth = [...allPayments, ...allDonations].reduce((acc, payment) => {
        if (!payment?.paymentDate) return acc;
        const monthKey = payment.paymentDate.substring(0, 7);
        if (!acc[monthKey]) acc[monthKey] = [];
        acc[monthKey].push(payment);
        return acc;
    }, {});
    const monthKeys = Object.keys(groupedByMonth).sort().reverse();
    if (!monthKeys.length) {
        container.innerHTML = buildEmptyState('No collector-wise monthly data available.', 'fa-users');
        return;
    }
    container.innerHTML = monthKeys.map((monthKey) => {
        const monthPayments = groupedByMonth[monthKey];
        const collectorRows = Object.values(monthPayments.reduce((acc, payment) => {
            const collectorKey = payment.collectedBy || 'unknown';
            if (!acc[collectorKey]) {
                acc[collectorKey] = {
                    collectorLabel: getStaffName(payment.collectedBy, payment.collectedByName),
                    monthlyDefaultTotal: 0,
                    monthlyOthersTotal: 0
                };
            }
            if (payment.entryType === 'donation') acc[collectorKey].monthlyOthersTotal += Number(payment.amount || 0);
            else {
                if (getPaymentItemType(payment) === 'month') acc[collectorKey].monthlyDefaultTotal += Number(payment.amount || 0);
                else acc[collectorKey].monthlyOthersTotal += Number(payment.amount || 0);
            }
            return acc;
        }, {})).sort((a, b) => (b.monthlyDefaultTotal + b.monthlyOthersTotal) - (a.monthlyDefaultTotal + a.monthlyOthersTotal));
        const monthTotalDefault = collectorRows.reduce((sum, row) => sum + row.monthlyDefaultTotal, 0);
        const monthTotalOthers = collectorRows.reduce((sum, row) => sum + row.monthlyOthersTotal, 0);
        return `
            <div class="bg-white border border-gray-200 rounded-xl p-4">
                <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-3 mb-3">
                    <h3 class="font-bold text-gray-800">${formatMonthLabel(monthKey)}</h3>
                    <div class="text-xs text-gray-500 font-semibold">Default: ${formatCurrency(monthTotalDefault)} • Others: ${formatCurrency(monthTotalOthers)}</div>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm text-left whitespace-nowrap">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="p-2">Collector</th>
                                <th class="p-2 text-right">Default Fee Total</th>
                                <th class="p-2 text-right">Others Fee Total</th>
                                <th class="p-2 text-right">Grand Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${collectorRows.map((row) => `
                                <tr class="border-b hover:bg-gray-50">
                                    <td class="p-2 font-semibold text-gray-800">${escapeHtml(row.collectorLabel)}</td>
                                    <td class="p-2 text-right">${formatCurrency(row.monthlyDefaultTotal)}</td>
                                    <td class="p-2 text-right">${formatCurrency(row.monthlyOthersTotal)}</td>
                                    <td class="p-2 text-right font-bold text-indigo-700">${formatCurrency(row.monthlyDefaultTotal + row.monthlyOthersTotal)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');
};

window.prepareHistoryData = prepareHistoryData;
window.updateDashboardMetrics = updateDashboardMetrics;
window.renderMonthlyCollectedPage = renderMonthlyCollectedPage;
window.renderCollectorWiseMonthlyPage = renderCollectorWiseMonthlyPage;

// --- STUDENTS INFO RENDER ---
const renderStudentInfoList = () => {
    const fCls = document.getElementById('stu-info-class').value;
    const fGen = document.getElementById('stu-info-gender').value;
    const sTerm = document.getElementById('stu-info-search').value.toLowerCase();
    const cont = document.getElementById('stu-info-list');
    const emptyState = document.getElementById('stu-info-empty');

    if (!fCls && !sTerm) {
        emptyState.classList.remove('hidden'); cont.classList.add('hidden'); return;
    }
    emptyState.classList.add('hidden'); cont.classList.remove('hidden');

    const fil = students.filter(s => {
        let match = true;
        if(fCls) match = match && s.class === fCls;
        if(fGen !== 'all') match = match && s.gender === fGen;
        if(sTerm) match = match && (s.name.toLowerCase().includes(sTerm) || (s.adm && s.adm.toLowerCase().includes(sTerm)));
        return match;
    });

    if(fil.length === 0) { cont.innerHTML = '<p class="text-gray-500 p-4 text-center font-medium">No students found.</p>'; return; }
    fil.sort((a, b) => a.name.localeCompare(b.name));

    cont.innerHTML = fil.map(s => `
        <div class="bg-white border border-gray-200 p-4 rounded-xl shadow-sm flex justify-between items-center cursor-pointer hover:border-blue-400 hover:shadow-md transition" onclick="window.openStudentProfile('${s.id}')">
            <div>
                <div class="font-bold text-gray-900 text-lg">${s.name}</div>
                <div class="text-sm text-gray-500">${s.class} (${s.gender}) | Adm: ${s.adm||'-'}</div>
            </div>
            <i class="fas fa-chevron-right text-gray-300"></i>
        </div>
    `).join('');
};
document.getElementById('stu-info-class').addEventListener('change', renderStudentInfoList);
document.getElementById('stu-info-gender').addEventListener('change', renderStudentInfoList);
document.getElementById('stu-info-search').addEventListener('input', renderStudentInfoList);


// --- INIT LISTENER ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        if (window.AppSession && window.AppSession.isFresh()) {
            try {
                await signInAnonymously(auth);
                return;
            } catch (authErr) {
                console.warn('Anonymous session recovery failed:', authErr);
            }
        }
        window.location.href = 'index.html';
        return;
    }
    hideLoader();
    const staffAccess = window.AppSession?.getStaffAccess?.() || null;
    const isDirectoryCollector = staffAccess?.source === 'directory';
    currentUserEmail = getEffectiveStaffEmail();
    currentCollectorKey = getCollectorKey();
    setupDonationEntryUI();
    selectedDutyClasses = [];
    collectorPaymentDetails = { accountName: '', upiNumber: '', upiId: '' };
    if (currentUserEmail) {
        selectedDutyClasses = readDutyClassesFromLocal();
        const savedDutyPayment = readDutyPaymentFromLocal();
        if (savedDutyPayment && typeof savedDutyPayment === 'object') {
            collectorPaymentDetails = { ...collectorPaymentDetails, ...savedDutyPayment };
        }
    }

    if (isDirectoryCollector) {
        isCurrentAdmin = false;
    } else {
        const adminRef = doc(db, `${BASE_PATH}/settings`, ADMIN_AUTH_DOC_ID);
        const adminSnap = await getDoc(adminRef);

        const adminData = adminSnap.exists() ? adminSnap.data() : {};
        const adminEmail = (adminData.email || '').toLowerCase();
        const adminAccounts = SINGLE_ADMIN_MODE ? [] : (Array.isArray(adminData.admins) ? adminData.admins : []);
        if(adminEmail === (currentUserEmail || '').toLowerCase() || adminAccounts.some((account) => (account.email || '').toLowerCase() === (currentUserEmail || '').toLowerCase() && account.isActive !== false)) {
            isCurrentAdmin = true;
            window.AppSession?.startAdmin();
        } else {
            isCurrentAdmin = false;
            window.AppSession?.startStaff(window.AppSession?.getStaffName?.() || '', currentUserEmail);
        }
    }

    const displayEl = document.getElementById('staff-name-display');
    setResultPageNavVisibility(isCurrentAdmin || staffAccess?.result === true);
    document.getElementById('collector-wise-monthly-tab')?.classList.toggle('hidden', !isCurrentAdmin);
    applyTabVisibilityPreferences();
    if (isCurrentAdmin) { displayEl.textContent = "ADMINISTRATOR"; }

    onSnapshot(collection(db, `${BASE_PATH}/staff`), (snap) => {
        allStaff = snap.docs.map(d => ({id: d.id, ...d.data()}));
        if (!isCurrentAdmin) {
            const myData = allStaff.find((staff) => normalizeEmail(staff.email) === normalizeEmail(currentUserEmail));
            if(myData && myData.isActive && myData.canCollect !== false) {
                currentUserEmail = normalizeEmail(myData.email || currentUserEmail || getEffectiveStaffEmail());
                currentCollectorKey = normalizeEmail(window.AppSession?.getStaffAccess?.()?.userKey || myData.email || currentUserEmail);
                displayEl.textContent = myData.name;
                window.AppSession?.startStaff(myData.name, currentUserEmail);
                const serverDutyClasses = Array.isArray(myData.dutyClasses) ? myData.dutyClasses.filter(Boolean) : [];
                selectedDutyClasses = serverDutyClasses;
                localStorage.setItem(getDutyStorageKey(), JSON.stringify(selectedDutyClasses));

                const serverDutyPayment = (myData.dutyPaymentDetails && typeof myData.dutyPaymentDetails === 'object') ? myData.dutyPaymentDetails : {};
                collectorPaymentDetails = serverDutyPayment;
                localStorage.setItem(getDutyPaymentStorageKey(), JSON.stringify(collectorPaymentDetails));
                setResultPageNavVisibility(myData.canManageResults === true || staffAccess?.result === true);
            } else {
                if (isDirectoryCollector) {
                    displayEl.textContent = window.AppSession?.getStaffName?.() || 'COLLECTOR';
                    setDutyPaymentDetailsInputs(collectorPaymentDetails);
                    renderStaffDirectory();
                    return;
                }
                window.AppSession?.clearAll({ purgeClientData: true });
                signOut(auth).finally(() => { window.location.href = 'index.html'; });
                return;
            }
        }
        if (isCurrentAdmin) setResultPageNavVisibility(true);
        if (isDirectoryCollector) {
            displayEl.textContent = window.AppSession?.getStaffName?.() || 'COLLECTOR';
        }
        setDutyPaymentDetailsInputs(collectorPaymentDetails);
        populateClassDropdowns();
        renderStaffDirectory();
        updateHistoryStaffFilter();
        if(document.getElementById('history-page').classList.contains('hidden') === false) prepareHistoryData();
        if(document.getElementById('collector-wise-monthly-page').classList.contains('hidden') === false) renderCollectorWiseMonthlyPage();
    });
    onSnapshot(collection(db, `${BASE_PATH}/publicDirectory`), (snap) => {
        directoryEntries = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
        renderStaffDirectory();
    });
    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'content'), (contentSnap) => {
        const payload = contentSnap.exists() ? contentSnap.data() : {};
        directoryCategories = Array.isArray(payload.directoryCategories) ? payload.directoryCategories : [];
        renderStaffDirectory();
    });
    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'pageAccess'), (accessSnap) => {
        const payload = accessSnap.exists() ? accessSnap.data() : {};
        pageAccessConfig = payload && typeof payload === 'object' ? { categories: {}, overrides: {}, ...payload } : { categories: {}, overrides: {} };
        renderStaffDirectory();
    });
    onSnapshot(getSessionRegistryRef(), (sessionSnap) => {
        const registry = sessionSnap.exists() ? sessionSnap.data() : {};
        const deviceId = getLocalDeviceId();
        const sessionEntry = registry?.sessions?.[deviceId] || null;
        if (!sessionEntry) return;
        if (sessionEntry.isBlocked === true || sessionEntry.forceLogout === true) {
            alert('This collection session is blocked or logged out by admin.');
            window.AppSession?.clearAll({ purgeClientData: true });
            signOut(auth).finally(() => { window.location.href = 'index.html'; });
        }
    });
    startCollectionSessionHeartbeat();
    window.AppSession?.touchSession();

    const sessionControlRef = doc(db, `${BASE_PATH}/settings`, 'sessionControl');
    onSnapshot(sessionControlRef, (sessionSnap) => {
        const sessionData = sessionSnap.exists() ? sessionSnap.data() : {};
        const startedAt = window.AppSession?.getStartedAt?.() || 0;
        const forcedAt = sessionData?.lastForcedLogoutAt ? new Date(sessionData.lastForcedLogoutAt).getTime() : 0;
        if (forcedAt && startedAt && forcedAt > startedAt) {
            alert(sessionData.message || 'An administrator ended this session. Please sign in again.');
            window.AppSession?.clearAll({ purgeClientData: true });
            signOut(auth).finally(() => { window.location.href = 'index.html'; });
        }
    });

    const confRef = doc(db, `${BASE_PATH}/settings`, 'config');
    onSnapshot(confRef, (docSnap) => {
        if (docSnap.exists()) {
            const d = docSnap.data();

            applyInstitutionBranding(d, {
                defaultAppName: 'Fee Collection',
                logoIds: ['header-logo', 'splash-logo-img'],
                updateDocumentTitle: true,
                documentTitleSuffix: 'Fee Collection'
            });
            renderVersionInfo();
            setTimeout(() => { fitTextToContainer('header-title'); }, 50);

            defaultFee = d.defaultFee || 200;
            feeStatusTitle = d.feeStatusTitle || '';
            feeItems = sortFeeItemsForDisplay(d.feeItems || []);
            defaultReceiptMandatory = d.defaultReceiptMandatory || false;

            window.defaultFee = defaultFee;
            window.feeItems = feeItems;
            window.defaultReceiptMandatory = defaultReceiptMandatory;
            window.feeStatusTitle = feeStatusTitle;
            window.getNextReceiptNoForStaff = getNextReceiptNoForStaff;
            window.getCollectorKey = getCollectorKey;
            checkReceiptMandatory();

            const fsh = document.getElementById('fee-status-title-header');
            if(fsh && feeStatusTitle) fsh.textContent = feeStatusTitle;

            if(!isEditMode && document.getElementById('home-page').classList.contains('hidden') === false) {
                setupFeeEntryUI();
            }
            if(document.getElementById('fee-page').classList.contains('hidden') === false) {
                renderFeeTable();
            }
        }
    });

    onSnapshot(collection(db, `${BASE_PATH}/students`), (snap) => {
        allStudentsRaw = snap.docs.map(d => ({id: d.id, ...d.data()}));
        applyCurrentYearStudentScope();
        populateClassDropdowns();
        updateDashboardMetrics();
        syncMasterLedgerState();
        hideLoader();
        if(document.getElementById('fee-page').classList.contains('hidden') === false) renderFeeTable();
        if(document.getElementById('students-page').classList.contains('hidden') === false) renderStudentInfoList();
    });

    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'academicYears'), (snap) => {
        const payload = snap.exists() ? snap.data() : {};
        academicYearSettings = Array.isArray(payload.years) ? payload.years : [];
        currentWorkingAcademicYear = payload.currentYear || currentWorkingAcademicYear || '';
        applyCurrentYearStudentScope();
        populateClassDropdowns();
        populateFeeStatusAcademicYears();
        setupBulkUploadUI();
        updateDashboardMetrics();
        syncMasterLedgerState();
        hideLoader();
        if(document.getElementById('fee-page').classList.contains('hidden') === false) renderFeeTable();
        if(document.getElementById('students-page').classList.contains('hidden') === false) renderStudentInfoList();
    });

    onSnapshot(collection(db, `${BASE_PATH}/studentGroups`), (snap) => {
        studentGroups = snap.docs.map(d => ({id: d.id, ...d.data()}));
        syncMasterLedgerState();
        hideLoader();
    });

    onSnapshot(collection(db, `${BASE_PATH}/payments`), (snap) => {
        allPayments = snap.docs.map(d => ({id: d.id, ...d.data()}));
        window.allPayments = allPayments;
        window.currentWorkingAcademicYear = currentWorkingAcademicYear;
        updateDashboardMetrics();
        updateHistoryStaffFilter();
        syncMasterLedgerState();
        hideLoader();

        if(!isEditMode && document.getElementById('home-page').classList.contains('hidden') === false) {
            if(!document.getElementById('entry-receipt').value) {
                 document.getElementById('entry-receipt').value = getNextReceiptNoForStaff();
            }
        }

        if(document.getElementById('history-page').classList.contains('hidden') === false) prepareHistoryData();
        if(document.getElementById('monthly-collected-page').classList.contains('hidden') === false) renderMonthlyCollectedPage(document.getElementById('monthly-collected-search-input').value);
        if(document.getElementById('collector-wise-monthly-page').classList.contains('hidden') === false) renderCollectorWiseMonthlyPage();
        if(document.getElementById('fee-page').classList.contains('hidden') === false) renderFeeTable();
    });

    onSnapshot(collection(db, `${BASE_PATH}/donations`), (snap) => {
        allDonations = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
        updateDashboardMetrics();
        if(document.getElementById('history-page').classList.contains('hidden') === false) prepareHistoryData();
        if(document.getElementById('monthly-collected-page').classList.contains('hidden') === false) renderMonthlyCollectedPage(document.getElementById('monthly-collected-search-input').value);
        if(document.getElementById('collector-wise-monthly-page').classList.contains('hidden') === false) renderCollectorWiseMonthlyPage();
    });
});
