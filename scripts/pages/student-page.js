import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, auth } from '../../config/firebase-config.js';
import { BASE_PATH, applyInstitutionBranding, buildEmptyState, enableSmartSelectWindowing, escapeHtml, formatCurrency, formatDateDisplay, hardenExternalLinks, registerServiceWorker, renderVersionInfo, sanitizeUrl } from '../shared/app-common.js';
import { registerPortalForPwa } from '../shared/pwa-install.js';

window.AppSession?.guardStudentPage?.();

const studentPwa = registerPortalForPwa('student', {
    menuItemId: 'student-install-menu-item',
    menuBtnId: 'student-install-btn'
});

        hardenExternalLinks();
        enableSmartSelectWindowing(document, { visibleCount: 6 });

        // Hamburger Menu Logic with 'X' Animation
        const mobileToggle = document.getElementById('mobile-menu-btn');
        const navMenu = document.querySelector('.nav-menu');
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

        const links = Array.from(document.querySelectorAll('.tab-link'));
        const pages = Array.from(document.querySelectorAll('.page-content'));
        const defaultTabId = 'home-page';
        let hasPublishedResults = false;
        const getLinkForTarget = (targetId) => links.find((link) => link.dataset.target === targetId);
        const getTargetFromHash = (hashValue) => {
            if (!hashValue) return defaultTabId;
            const normalizedHash = hashValue.startsWith('#') ? hashValue : `#${hashValue}`;
            const matchedLink = links.find((link) => link.getAttribute('href') === normalizedHash);
            return matchedLink?.dataset.target || defaultTabId;
        };
        const activateStudentTab = (targetId, { updateHash = true } = {}) => {
            const safeTargetId = document.getElementById(targetId) ? targetId : defaultTabId;
            const activeLink = getLinkForTarget(safeTargetId);
            if (!activeLink) return;
            links.forEach((link) => {
                const isActive = link === activeLink;
                link.classList.toggle('active', isActive);
                link.setAttribute('aria-current', isActive ? 'page' : 'false');
            });
            pages.forEach((page) => page.classList.toggle('hidden', page.id !== safeTargetId));
            if (updateHash) {
                const nextHash = activeLink.getAttribute('href');
                if (nextHash && window.location.hash !== nextHash) {
                    history.pushState({ studentTab: safeTargetId }, '', nextHash);
                }
            }
            setMobileMenuState(false);
            window.scrollTo(0,0);
            document.querySelectorAll('.student-bottom-nav-btn[data-target]').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.target === safeTargetId);
            });
        };
        
        window.activateStudentTab = activateStudentTab;

        links.forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                activateStudentTab(link.dataset.target);
            });
        });
        window.addEventListener('hashchange', () => activateStudentTab(getTargetFromHash(window.location.hash), { updateHash: false }));
        window.addEventListener('popstate', () => activateStudentTab(getTargetFromHash(window.location.hash), { updateHash: false }));
        activateStudentTab(getTargetFromHash(window.location.hash), { updateHash: false });

        // Inline Accordion Expansion (No Popup)
        window.toggleReceipt = (element) => {
            const isShowing = element.classList.contains('show-details');
            document.querySelectorAll('.fee-card.show-details').forEach(el => el.classList.remove('show-details'));
            if (!isShowing) {
                element.classList.add('show-details');
                setTimeout(() => { element.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 150);
            }
        };

        let copyButtonBound = false;
        const bindCopyButtons = () => {
            if (copyButtonBound) return;
            copyButtonBound = true;
            document.addEventListener('click', async (event) => {
                const copyBtn = event.target.closest('.copy-pay-detail-btn');
                if (!copyBtn) return;
                event.stopPropagation();
                const rawValue = decodeURIComponent(copyBtn.dataset.copyValue || '');
                if (!rawValue) return;
                const originalHtml = copyBtn.innerHTML;
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(rawValue);
                    } else {
                        const tempInput = document.createElement('textarea');
                        tempInput.value = rawValue;
                        document.body.appendChild(tempInput);
                        tempInput.select();
                        document.execCommand('copy');
                        tempInput.remove();
                    }
                    copyBtn.innerHTML = '<i class="fas fa-check text-emerald-600"></i>';
                    setTimeout(() => { copyBtn.innerHTML = originalHtml; }, 1500);
                } catch (error) {
                    console.warn('Copy failed', error);
                }
            });
        };
        bindCopyButtons();

        const confirmLogout = () => confirm('Are you sure you want to log out?');
        async function logoutStudent({ skipConfirm = false } = {}) {
            if(!skipConfirm && !confirmLogout()) return;
            window.AppSession?.logoutStudent(window.AppSession?.getStudentId?.(), { removeAccount: false });
            window.location.href = 'index.html?public=1';
        }
        window.logoutStudent = logoutStudent;
        document.getElementById('student-logout-btn')?.addEventListener('click', () => logoutStudent());
        document.getElementById('student-public-btn')?.addEventListener('click', () => { window.location.href = 'index.html?public=1'; });
        document.querySelectorAll('.student-bottom-nav-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.action === 'public') { window.location.href = 'index.html?public=1'; return; }
                if (btn.dataset.target) activateStudentTab(btn.dataset.target);
            });
        });
        document.querySelectorAll('.student-public-nav-link').forEach((link) => {
            link.addEventListener('click', () => {
                setMobileMenuState(false);
            });
        });

        const accountSwitcher = document.getElementById('student-account-switcher');
        const accountList = document.getElementById('student-account-list');
        const renderAccountSwitcher = () => {
            const accounts = window.AppSession?.getStudentAccounts?.() || [];
            const activeId = window.AppSession?.getStudentId?.();
            accountList.innerHTML = accounts.length ? accounts.map((account) => {
                const isActive = account.studentId === activeId;
                return `<div class="rounded-xl border ${isActive ? 'border-blue-200 bg-blue-50/70' : 'border-slate-200 bg-white'} px-3 py-2.5 flex items-center justify-between gap-2 transition">
                    <button class="text-left flex-grow account-switch-btn" data-id="${account.studentId}">
                        <div class="font-semibold ${isActive ? 'text-blue-700' : 'text-slate-800'}">${escapeHtml(account.name || 'Student')}</div>
                        <div class="text-xs ${isActive ? 'text-blue-600' : 'text-slate-500'}">${escapeHtml(account.class || '--')} • Adm: ${escapeHtml(account.adm || '--')}</div>
                    </button>
                    <div class="flex items-center gap-1.5">
                        ${isActive ? '<span class="text-[10px] font-bold uppercase tracking-wide text-blue-700 bg-blue-100 px-2 py-1 rounded-full">Active</span>' : ''}
                        <button class="text-red-600 hover:text-red-700 text-xs font-bold account-remove-btn" data-id="${account.studentId}">Remove</button>
                    </div>
                </div>`;
            }).join('') : '<p class="text-sm text-gray-500">No saved accounts.</p>';
        };
        const switchToStudentAccount = (targetStudentId = '') => {
            if (!targetStudentId) return false;
            const switched = window.AppSession?.switchStudent?.(targetStudentId);
            if (!switched) return false;
            window.location.reload();
            return true;
        };
        const handleQuickProfileSwitch = () => {
            const accounts = window.AppSession?.getStudentAccounts?.() || [];
            const activeId = window.AppSession?.getStudentId?.();
            if (accounts.length === 2) {
                const target = accounts.find((account) => account.studentId !== activeId);
                if (target?.studentId && switchToStudentAccount(target.studentId)) return true;
            }
            return false;
        };
        const openAccountSwitcher = ({ forceList = false } = {}) => {
            const accounts = window.AppSession?.getStudentAccounts?.() || [];
            if (!forceList && accounts.length === 2 && handleQuickProfileSwitch()) return;
            renderAccountSwitcher();
            accountSwitcher.classList.remove('hidden');
            accountSwitcher.classList.add('flex');
        };
        const closeAccountSwitcher = () => {
            accountSwitcher.classList.add('hidden');
            accountSwitcher.classList.remove('flex');
        };
        let longPressTimer = null;
        const bindLongPress = (element) => {
            if (!element) return;
            element.addEventListener('pointerdown', () => {
                longPressTimer = setTimeout(() => openAccountSwitcher({ forceList: true }), 650);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => {
                element.addEventListener(eventName, () => {
                    if (longPressTimer) clearTimeout(longPressTimer);
                    longPressTimer = null;
                });
            });
        };
        const bindProfileDoubleTap = (element) => {
            if (!element) return;
            element.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!handleQuickProfileSwitch()) {
                    openAccountSwitcher({ forceList: true });
                }
            });
        };
        const profileTabLink = document.querySelector('.tab-link[data-target="home-page"]');
        const bottomProfileBtn = document.getElementById('bottom-profile-btn');
        bindLongPress(profileTabLink);
        bindLongPress(bottomProfileBtn);
        bindProfileDoubleTap(profileTabLink);
        bindProfileDoubleTap(bottomProfileBtn);
        document.getElementById('close-account-switcher')?.addEventListener('click', closeAccountSwitcher);
        accountSwitcher?.addEventListener('click', (e) => {
            if (e.target === accountSwitcher) closeAccountSwitcher();
        });
        accountList?.addEventListener('click', (e) => {
            const switchBtn = e.target.closest('.account-switch-btn');
            const removeBtn = e.target.closest('.account-remove-btn');
            if (switchBtn) {
                switchToStudentAccount(switchBtn.dataset.id);
            }
            if (removeBtn) {
                if (!confirm('Are you sure you want to remove this account?')) return;
                const activeId = window.AppSession?.getStudentId?.() || '';
                window.AppSession?.logoutStudent(removeBtn.dataset.id, { removeAccount: true });
                if (activeId === removeBtn.dataset.id) window.location.href = 'index.html';
                else renderAccountSwitcher();
            }
        });
        document.getElementById('account-switcher-logout-btn')?.addEventListener('click', () => logoutStudent());
        document.getElementById('account-switcher-add-btn')?.addEventListener('click', () => {
            window.location.href = 'index.html?addStudent=1';
        });

        // ----------------------------------------------------
        // NOTIFICATION ENGINE LOGIC (WITH APP BADGE, ENABLE/DISABLE TOGGLE & DAILY DUE RE-TRIGGER)
        // ----------------------------------------------------
        let notifState = { lastMarkedAllReadAt: 0, readIds: [], feeDismissedDates: {} };
        let notifStateLoaded = false;
        let rawSysNotifs = [];
        let rawNotices = [];
        let rawFeeAlerts = [];
        let rawResultAlerts = [];
        let latestMergedNotifications = [];
        let baseDocumentTitle = document.title || 'Student Dashboard';

        const getTodayDateKey = () => {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        };

        const getPhoneNotifyPrefKey = () => `student_phone_notify_pref_v2_${window.AppSession?.getStudentId?.() || 'default'}`;
        const getPhoneNotifyPromptShownKey = () => `student_phone_notify_prompted_v2_${window.AppSession?.getStudentId?.() || 'default'}`;
        const getNotifiedPushStoreKey = () => `student_push_notified_v2_${window.AppSession?.getStudentId?.() || 'default'}`;
        const getFeeDismissedLocalKey = () => `student_fee_dismissed_dates_v2_${window.AppSession?.getStudentId?.() || 'default'}`;

        const getLocalFeeDismissedMap = () => {
            try {
                const raw = localStorage.getItem(getFeeDismissedLocalKey());
                const parsed = raw ? JSON.parse(raw) : {};
                return (parsed && typeof parsed === 'object') ? parsed : {};
            } catch (_e) {
                return {};
            }
        };

        const saveLocalFeeDismissedMap = (mapObj = {}) => {
            try {
                localStorage.setItem(getFeeDismissedLocalKey(), JSON.stringify(mapObj || {}));
            } catch (_e) {}
        };

        const isFeeDismissedForToday = (notifId) => {
            const todayKey = getTodayDateKey();
            const localMap = getLocalFeeDismissedMap();
            const remoteMap = (notifState.feeDismissedDates && typeof notifState.feeDismissedDates === 'object')
                ? notifState.feeDismissedDates
                : {};
            return localMap[notifId] === todayKey || remoteMap[notifId] === todayKey;
        };

        const dismissFeeNotificationForToday = async (notifIds = []) => {
            const ids = (Array.isArray(notifIds) ? notifIds : [notifIds]).filter(Boolean);
            if (!ids.length) return;
            const todayKey = getTodayDateKey();
            const localMap = getLocalFeeDismissedMap();
            if (!notifState.feeDismissedDates || typeof notifState.feeDismissedDates !== 'object') {
                notifState.feeDismissedDates = {};
            }
            ids.forEach((id) => {
                localMap[id] = todayKey;
                notifState.feeDismissedDates[id] = todayKey;
            });
            saveLocalFeeDismissedMap(localMap);

            // Also close any active phone notification in status bar for these IDs
            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    if (reg && typeof reg.getNotifications === 'function') {
                        const activeNotifs = await reg.getNotifications();
                        activeNotifs.forEach((n) => {
                            if (ids.includes(n.data?.notifId)) n.close();
                        });
                    }
                } catch (_e) {}
            }

            renderNotificationPanel();
            try {
                await setDoc(doc(db, BASE_PATH + '/studentNotificationState', studentId), {
                    feeDismissedDates: notifState.feeDismissedDates
                }, { merge: true });
            } catch (_e) {}
        };

        const isPhoneNotificationEnabled = () => {
            const pref = localStorage.getItem(getPhoneNotifyPrefKey());
            if (pref === 'disabled') return false;
            if (pref === 'enabled') {
                if ('Notification' in window && Notification.permission === 'denied') return false;
                return true;
            }
            return false;
        };

        const getNotifiedPushMap = () => {
            try {
                const raw = localStorage.getItem(getNotifiedPushStoreKey());
                const parsed = raw ? JSON.parse(raw) : null;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                return null;
            } catch (_e) {
                return null;
            }
        };

        const saveNotifiedPushMap = (mapObj) => {
            try {
                const entries = Object.entries(mapObj || {}).slice(-250);
                localStorage.setItem(getNotifiedPushStoreKey(), JSON.stringify(Object.fromEntries(entries)));
            } catch (_e) {}
        };

        const syncAppIconBadgeCount = (unreadCount = 0) => {
            const count = Math.max(0, Number(unreadCount) || 0);
            // 1. Update PWA App Icon Badge (Badging API)
            if ('setAppBadge' in navigator && 'clearAppBadge' in navigator) {
                if (count > 0) {
                    navigator.setAppBadge(count).catch(() => {});
                } else {
                    navigator.clearAppBadge().catch(() => {});
                }
            }
            // 2. Sync with Service Worker for background persistence
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: 'SYNC_APP_BADGE',
                    count
                });
            }
            // 3. Update Document Title with unread count like WhatsApp Web / Mobile
            const cleanBase = (document.getElementById('header-title')?.textContent?.trim() || baseDocumentTitle).replace(/^\(\d+\+?\)\s*/, '');
            document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${cleanBase}` : cleanBase;
        };

        const updatePhoneNotifyPermissionBanner = () => {
            const banner = document.getElementById('student-notify-perm-banner');
            const btn = document.getElementById('student-enable-phone-notify-btn');
            const textEl = document.getElementById('student-notify-perm-text');
            const subtextEl = document.getElementById('student-notify-perm-subtext');
            const iconEl = document.getElementById('student-notify-perm-icon');
            if (!banner || !btn) return;

            banner.classList.remove('hidden');
            const enabled = isPhoneNotificationEnabled();
            const browserDenied = ('Notification' in window) && Notification.permission === 'denied';

            if (enabled) {
                banner.className = 'px-3.5 py-2.5 bg-emerald-50/90 border-b border-emerald-100 flex items-center justify-between gap-2.5';
                if (iconEl) iconEl.className = 'fas fa-bell text-emerald-600 text-sm shrink-0';
                if (textEl) textEl.textContent = 'Phone notifications are active';
                if (subtextEl) subtextEl.textContent = 'Instant notices & daily due alerts enabled';
                btn.textContent = 'Disable';
                btn.className = 'shrink-0 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[11px] font-bold px-3 py-1.5 rounded-lg transition cursor-pointer';
            } else {
                banner.className = 'px-3.5 py-2.5 bg-blue-50/90 border-b border-blue-100 flex items-center justify-between gap-2.5';
                if (iconEl) iconEl.className = 'fas fa-mobile-screen-button text-blue-600 text-sm shrink-0';
                if (textEl) textEl.textContent = 'Get instant notices & alerts in your phone notification center';
                if (subtextEl) {
                    subtextEl.textContent = browserDenied
                        ? 'Allow notification permission in browser settings or tap Enable'
                        : 'Tap Enable to receive phone notifications';
                }
                btn.textContent = 'Enable';
                btn.className = 'shrink-0 bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold px-3 py-1.5 rounded-lg shadow-xs transition cursor-pointer';
            }
        };

        const triggerPhoneSystemNotification = async (item, forceShow = false) => {
            if (!forceShow && !isPhoneNotificationEnabled()) return;
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            const logoSrc = document.getElementById('header-logo')?.getAttribute('src') || './assets/images/logo.png';
            const payload = {
                title: item.title || 'New School Update',
                body: item.message || 'Tap to view details in Student Dashboard.',
                icon: logoSrc,
                badge: logoSrc,
                tag: `stu-notif-${item.id}`,
                url: './student.html',
                target: item.target || 'home-page',
                notifId: item.id
            };

            try {
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.ready;
                    if (reg && typeof reg.showNotification === 'function') {
                        await reg.showNotification(payload.title, {
                            body: payload.body,
                            icon: payload.icon,
                            badge: payload.badge,
                            tag: payload.tag,
                            renotify: true,
                            vibrate: [200, 100, 200],
                            data: {
                                url: payload.url,
                                target: payload.target,
                                notifId: payload.notifId
                            }
                        });
                        return;
                    }
                }
                const n = new Notification(payload.title, {
                    body: payload.body,
                    icon: payload.icon,
                    tag: payload.tag
                });
                n.onclick = () => {
                    window.focus();
                    window.handleNotifyClick(item.id, item.target || '');
                    n.close();
                };
                n.onclose = () => {
                    if (String(item.id || '').startsWith('fee-')) {
                        dismissFeeNotificationForToday([item.id]);
                    }
                };
            } catch (_err) {}
        };

        const enablePhoneNotifications = async () => {
            let granted = false;
            if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    granted = true;
                } else {
                    try {
                        const result = await Notification.requestPermission();
                        granted = result === 'granted';
                    } catch (_e) {
                        granted = false;
                    }
                }
            }

            if ('Notification' in window && Notification.permission === 'denied') {
                localStorage.setItem(getPhoneNotifyPrefKey(), 'disabled');
                updatePhoneNotifyPermissionBanner();
                openStudentDetailModal(
                    'Notification Permission Blocked',
                    `<div class="space-y-2 text-xs text-slate-700 leading-relaxed">
                        <p class="font-bold text-red-600"><i class="fas fa-circle-exclamation mr-1"></i> Browser notification permission is currently blocked.</p>
                        <p>Please tap the lock / tune icon next to the address bar in your browser, allow <b>Notifications</b>, and then tap <b>Enable</b> again.</p>
                    </div>`
                );
                return false;
            }

            // Enable preference (works even if preview environment handles permissions internally)
            localStorage.setItem(getPhoneNotifyPrefKey(), 'enabled');
            localStorage.setItem(getPhoneNotifyPromptShownKey(), '1');
            updatePhoneNotifyPermissionBanner();

            // Reset push tracker for current unread items so current unread/due items immediately appear on the phone
            const unreadItems = latestMergedNotifications.filter((n) => !n.isRead);
            if (granted) {
                if (unreadItems.length > 0) {
                    const todayKey = getTodayDateKey();
                    const pushMap = getNotifiedPushMap() || {};
                    unreadItems.slice(0, 3).forEach((item) => {
                        pushMap[item.id] = item.type === 'fee' ? todayKey : 'sent';
                        triggerPhoneSystemNotification(item, true);
                    });
                    saveNotifiedPushMap(pushMap);
                } else {
                    triggerPhoneSystemNotification({
                        id: `welcome-enable-${Date.now()}`,
                        title: 'Notifications Enabled',
                        message: 'You will now receive instant notices & daily fee due alerts on your phone.',
                        target: 'home-page'
                    }, true);
                }
            }
            return true;
        };

        const disablePhoneNotifications = async () => {
            localStorage.setItem(getPhoneNotifyPrefKey(), 'disabled');
            localStorage.setItem(getPhoneNotifyPromptShownKey(), '1');
            updatePhoneNotifyPermissionBanner();

            // Close any active phone notifications from this app
            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    if (reg && typeof reg.getNotifications === 'function') {
                        const list = await reg.getNotifications();
                        list.forEach((n) => n.close());
                    }
                } catch (_e) {}
            }
        };

        const maybeShowStartupNotificationPrompt = () => {
            const modal = document.getElementById('student-notify-confirm-modal');
            if (!modal) return;
            const pref = localStorage.getItem(getPhoneNotifyPrefKey());
            const alreadyPrompted = localStorage.getItem(getPhoneNotifyPromptShownKey());

            // If user already granted in browser and hasn't explicitly disabled, auto-enable seamlessly
            if (!pref && 'Notification' in window && Notification.permission === 'granted') {
                localStorage.setItem(getPhoneNotifyPrefKey(), 'enabled');
                updatePhoneNotifyPermissionBanner();
                return;
            }

            // Show default startup confirmation popup if not yet configured/prompted
            if (!pref && !alreadyPrompted) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        };

        const dispatchNewPhoneNotifications = (unreadItems = []) => {
            if (!notifStateLoaded || !isPhoneNotificationEnabled()) return;
            const todayKey = getTodayDateKey();
            const existingMap = getNotifiedPushMap() || {};

            // Fee due items notify once per calendar day (if still unpaid and not dismissed today).
            // Other notices/results notify once per unique item ID.
            const itemsToPush = unreadItems.filter((item) => {
                if (item.type === 'fee') {
                    return existingMap[item.id] !== todayKey;
                }
                return !existingMap[item.id];
            });

            if (!itemsToPush.length) return;

            itemsToPush.forEach((item) => {
                existingMap[item.id] = item.type === 'fee' ? todayKey : 'sent';
            });
            saveNotifiedPushMap(existingMap);

            // Dispatch up to 3 newest alerts to the phone notification center
            itemsToPush.slice(0, 3).forEach((item) => {
                triggerPhoneSystemNotification(item);
            });
        };

        const toggleNotifyPanel = (show) => {
            const panel = document.getElementById('student-notify-panel');
            const backdrop = document.getElementById('student-notify-backdrop');
            if (!panel || !backdrop) return;
            if (show) updatePhoneNotifyPermissionBanner();
            panel.classList.toggle('active', Boolean(show));
            backdrop.classList.toggle('opacity-0', !show);
            backdrop.classList.toggle('pointer-events-none', !show);
        };
        const openStudentDetailModal = (title = 'Details', html = '') => {
            const modal = document.getElementById('student-detail-modal');
            if (!modal) return;
            document.getElementById('student-detail-modal-title').textContent = title;
            document.getElementById('student-detail-modal-body').innerHTML = html;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.body.classList.add('overflow-hidden');
        };
        const closeStudentDetailModal = () => {
            const modal = document.getElementById('student-detail-modal');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.classList.remove('overflow-hidden');
        };
        const latestFeeInsightState = { paid: [], pending: [], payments: [] };
        const buildFeeListModalHtml = (items = [], emptyText = 'No items found.') => {
            if (!items.length) return `<div class="shared-empty-state"><i class="fas fa-circle-info"></i><span>${escapeHtml(emptyText)}</span></div>`;
            return `<div class="space-y-3">${items.map((item) => `
                <div class="fee-modal-list-item ${item.status === 'paid' ? 'paid' : 'pending'}">
                    <div class="flex items-start justify-between gap-3">
                        <div>
                            <div class="text-[11px] font-extrabold uppercase tracking-widest text-slate-400">${escapeHtml(item.academicYear || '--')}</div>
                            <div class="text-sm font-extrabold text-slate-800 mt-1">${escapeHtml(item.name || 'Fee Item')}</div>
                        </div>
                        <div class="text-right font-mono font-extrabold ${item.status === 'paid' ? 'text-emerald-700' : 'text-red-600'}">${formatCurrency(item.amount || 0)}</div>
                    </div>
                    ${item.meta ? `<div class="mt-2 text-xs font-semibold text-slate-500">${item.meta}</div>` : ''}
                </div>
            `).join('')}</div>`;
        };
        window.openFeeDetailModal = (cardEl) => {
            const feeCard = cardEl?.closest?.('.fee-card') || cardEl;
            const title = feeCard?.querySelector('.fee-month')?.textContent?.trim() || 'Fee Details';
            const detailHtml = feeCard?.querySelector('.fee-details-panel')?.innerHTML || '<p>No details available.</p>';
            openStudentDetailModal(title, `<div class="space-y-3">${detailHtml}</div>`);
        };
        window.openFeeInsightModal = (type) => {
            if (type === 'paid') {
                openStudentDetailModal('Paid Items', buildFeeListModalHtml(latestFeeInsightState.paid, 'No paid fee items in this academic year.'));
            } else if (type === 'pending') {
                openStudentDetailModal('Pending Items', buildFeeListModalHtml(latestFeeInsightState.pending, 'No pending fee items in this academic year.'));
            } else if (type === 'last') {
                openStudentDetailModal('Last Payment', buildFeeListModalHtml(latestFeeInsightState.payments, 'No payment has been recorded yet.'));
            }
        };

        const stableNotificationHash = (value = '') => {
            const str = String(value || '');
            let hash = 0;
            for (let i = 0; i < str.length; i += 1) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash |= 0;
            }
            return Math.abs(hash).toString(36);
        };
        const getNoticeTimestamp = (notice = {}, fallbackIndex = 0, field = 'createdAt') => {
            const numericValue = Number(notice[field] || 0);
            if (Number.isFinite(numericValue) && numericValue > 0) return numericValue;
            const dateValue = notice.date ? new Date(notice.date).getTime() : 0;
            return Number.isFinite(dateValue) && dateValue > 0 ? dateValue + fallbackIndex : Date.now() - fallbackIndex;
        };
        const renderNoticeTextWithLinks = (rawText = '', linkLabelLength = 25) => {
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
                    html += `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline font-semibold break-all">${escapeHtml(shortLabel)}</a>`;
                } else {
                    html += escapeHtml(url);
                }
                cursor = offset + url.length;
                return url;
            });
            html += escapeHtml(text.slice(cursor));
            return html.replace(/\n/g, '<br>');
        };

        const buildPublicNoticeNotifications = () => {
            const alerts = [];
            rawNotices.forEach((notice = {}, idx) => {
                const rawHeading = String(notice.heading || notice.title || '').trim();
                const text = String(notice.text || notice.content || '').trim();
                const rawImg = String(notice.image || notice.imageUrl || '').trim();
                const safeImage = (rawImg && rawImg.startsWith('data:image/')) ? rawImg : sanitizeUrl(rawImg);
                const dateStr = notice.date || '';
                const baseKey = notice.id || `${rawHeading}|${dateStr}|${text}|${safeImage ? safeImage.slice(-32) : ''}`;
                const fallbackTs = Number(notice.createdAt || notice.updatedAt || notice.pinnedAt || 0)
                    || (notice.date ? new Date(notice.date).getTime() : 0)
                    || (1704067200000 + (stableNotificationHash(baseKey).split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) * 1000));
                const displayHeading = rawHeading || (safeImage && !text ? 'Image Notice' : 'Notice');
                const summaryMessage = text || (safeImage ? 'Tap to view attached notice image.' : '');
                alerts.push({
                    id: `notice-new-${stableNotificationHash(baseKey)}`,
                    type: 'notice',
                    icon: safeImage && !text ? 'fa-image' : 'fa-bullhorn',
                    title: rawHeading ? `Notice: ${rawHeading}` : (safeImage ? 'New Image Notice' : 'New Notice'),
                    heading: rawHeading,
                    displayHeading,
                    image: safeImage || '',
                    date: dateStr,
                    pinned: Boolean(notice.pinned),
                    message: summaryMessage,
                    rawText: text,
                    timestamp: getNoticeTimestamp({ ...notice, createdAt: fallbackTs }, idx, 'createdAt'),
                    target: 'notice-modal'
                });
                if (notice.pinned === true) {
                    alerts.push({
                        id: `notice-pinned-${stableNotificationHash(baseKey)}-${notice.pinnedAt || 'active'}`,
                        type: 'notice',
                        icon: 'fa-thumbtack',
                        title: rawHeading ? `Pinned Notice: ${rawHeading}` : 'Pinned Notice',
                        heading: rawHeading,
                        displayHeading,
                        image: safeImage || '',
                        date: dateStr,
                        pinned: true,
                        message: text || (safeImage ? 'An important image notice has been pinned.' : 'An important notice has been pinned on the public page.'),
                        rawText: text,
                        timestamp: getNoticeTimestamp({ ...notice, pinnedAt: fallbackTs }, idx, 'pinnedAt'),
                        target: 'notice-modal'
                    });
                }
            });
            return alerts;
        };
        const buildResultNotificationAlerts = (profile = {}, results = []) => {
            const alerts = [];
            const classLabel = profile?.class || '';
            const activeYear = currentAcademicYear || profile?.academicYear || selectedFeeAcademicYear || '';
            const visibleResults = results.filter((result) => {
                if (result.published === false) return false;
                if (!activeYear) return true;
                return (result.academicYear || profile?.academicYear || '') === activeYear;
            });
            visibleResults.forEach((result) => {
                const resultClass = result.classLabel || classByYear[result.academicYear] || classLabel;
                if (resultCenterSettings.blockedClasses?.includes(resultClass)) return;
                const examLabel = getStudentResultExamLabel(result);
                const academicYear = result.academicYear || profile?.academicYear || '--';
                const parsedTs = typeof result.updatedAt === 'string' ? new Date(result.updatedAt).getTime() : Number(result.publishedAt || result.updatedAt || 0);
                alerts.push({
                    id: `result-published-${result.id || stableNotificationHash(`${result.studentId || studentId}|${academicYear}|${examLabel}`)}`,
                    type: 'result',
                    icon: 'fa-square-poll-vertical',
                    title: `${examLabel} Result Published`,
                    message: `${academicYear} academic year result is now available for ${resultClass || 'your class'}.`,
                    timestamp: (Number.isFinite(parsedTs) && parsedTs > 0) ? parsedTs : Date.now(),
                    target: 'results-page'
                });
            });

            const publishTs = resultCenterSettings.publishAt ? new Date(resultCenterSettings.publishAt).getTime() : 0;
            const countdownActive = (resultCenterSettings.locked === true) || (Number.isFinite(publishTs) && publishTs > Date.now());
            if (countdownActive && !resultCenterSettings.blockedClasses?.includes(classLabel)) {
                const examLabel = resultCenterSettings.examLabel || 'Upcoming Exam';
                const publishLabel = formatPublishDateTime(resultCenterSettings.publishAt);
                alerts.push({
                    id: `result-countdown-${stableNotificationHash(`${examLabel}|${resultCenterSettings.publishAt || 'locked'}`)}`,
                    type: 'result',
                    icon: 'fa-hourglass-half',
                    title: 'Result Countdown Started',
                    message: `${examLabel} result countdown has started. Scheduled publish time: ${publishLabel}.`,
                    timestamp: Number(resultCenterSettings.countdownStartedAt || resultCenterSettings.updatedAt || 0) || (Number.isFinite(publishTs) ? publishTs : Date.now()),
                    target: 'results-page'
                });
            }
            return alerts;
        };

        const renderNotificationPanel = () => {
            const allNotifs = [];
            
            rawSysNotifs.forEach(n => {
                if (n.expiryDate && n.expiryDate < Date.now()) return;
                if (n.audience === 'students' || n.audience === 'all' || (n.audience === 'specific' && n.audienceIds?.includes(studentId))) {
                    allNotifs.push({
                        id: n.id, type: 'sys', icon: n.icon || 'fa-info-circle',
                        title: n.title, message: n.message, timestamp: n.createdAt || Date.now(),
                        target: n.target || 'home-page'
                    });
                }
            });

            allNotifs.push(...buildPublicNoticeNotifications());

            const merged = [...allNotifs, ...rawFeeAlerts, ...rawResultAlerts].reduce((acc, curr) => {
                if (!acc.some(x => x.id === curr.id)) acc.push(curr);
                return acc;
            }, []).sort((a, b) => b.timestamp - a.timestamp);
            latestMergedNotifications = merged;

            // Mark each notification read/unread accurately
            // Fee notifications can be cleared for today (from phone notification center or panel),
            // and automatically become unread/active again tomorrow if still unpaid.
            merged.forEach((notification) => {
                const isRead = notification.type === 'fee'
                    ? isFeeDismissedForToday(notification.id)
                    : (
                        (notifState.lastMarkedAllReadAt > 0 && notification.timestamp <= notifState.lastMarkedAllReadAt) ||
                        notifState.readIds.includes(notification.id)
                    );
                notification.isRead = isRead;
            });

            const unreadNotifications = merged.filter((n) => !n.isRead);
            const unreadCount = unreadNotifications.length;
            updatePhoneNotifyPermissionBanner();

            // Update header bell badge & panel badge & phone app icon badge
            const badge = document.getElementById('student-notify-badge');
            const panelCountBadge = document.getElementById('student-notify-panel-count');
            const formattedCount = unreadCount > 99 ? '99+' : String(unreadCount);

            if (unreadCount > 0) {
                if (badge) {
                    badge.textContent = formattedCount;
                    badge.classList.remove('hidden');
                }
                if (panelCountBadge) {
                    panelCountBadge.textContent = formattedCount;
                    panelCountBadge.classList.remove('hidden');
                }
            } else {
                badge?.classList.add('hidden');
                panelCountBadge?.classList.add('hidden');
            }

            syncAppIconBadgeCount(unreadCount);
            dispatchNewPhoneNotifications(unreadNotifications);

            const listContainer = document.getElementById('student-notify-list');
            if (!listContainer) return;
            listContainer.innerHTML = '';
            
            if (merged.length === 0) {
                listContainer.innerHTML = `<div class="notify-empty-state"><i class="fas fa-bell-slash"></i><span>No notifications yet</span></div>`;
                return;
            }

            // Show unread notifications first, followed by recent read notifications so notices are always accessible
            const displayList = [
                ...unreadNotifications,
                ...merged.filter((n) => n.isRead).slice(0, 20)
            ];

            const todayStart = new Date().setHours(0,0,0,0);
            const yesterdayStart = todayStart - 86400000;
            let currentGroup = '';

            displayList.forEach(n => {
                let groupLabel = n.isRead ? 'Earlier (Cleared / Read)' : 'Older';
                if (!n.isRead) {
                    if (n.timestamp >= todayStart) groupLabel = 'New Today';
                    else if (n.timestamp >= yesterdayStart) groupLabel = 'Yesterday';
                    else groupLabel = 'Unread';
                }

                if (groupLabel !== currentGroup) {
                    currentGroup = groupLabel;
                    listContainer.innerHTML += `<div class="notify-group-label">${groupLabel}</div>`;
                }

                const iconClass = n.type === 'sys' ? 'sys' : (n.type === 'fee' ? 'fee' : (n.type === 'result' ? 'result' : 'notice'));
                const timeAgoStr = n.timestamp ? new Date(n.timestamp).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year: 'numeric' }) : 'Just now';
                const canClearDueToday = n.type === 'fee' && !n.isRead;
                const msgHtml = (n.type === 'notice' || n.type === 'sys')
                    ? renderNoticeTextWithLinks(n.message || '', 25)
                    : escapeHtml(n.message || '');
                const thumbHtml = n.image
                    ? `<div class="mt-1.5 rounded-lg overflow-hidden border border-slate-200 bg-slate-50 max-h-28 flex justify-center"><img src="${n.image}" alt="Notice attachment" class="max-h-28 w-auto object-contain"></div>`
                    : '';

                listContainer.innerHTML += `
                    <div class="notify-item ${n.isRead ? 'opacity-75' : 'unread'} flex items-start gap-2.5" data-notification-id="${escapeHtml(n.id)}" data-notification-target="${escapeHtml(n.target || '')}" role="button" tabindex="0">
                        <div class="notify-icon ${iconClass}"><i class="fas ${n.icon}"></i></div>
                        <div class="notify-content flex-1 min-w-0">
                            <div class="notify-title">${escapeHtml(n.title)}</div>
                            ${n.message ? `<div class="notify-msg line-clamp-2">${msgHtml}</div>` : ''}
                            ${thumbHtml}
                            <div class="notify-time flex items-center justify-between gap-2 mt-1">
                                <span><i class="far fa-clock text-[9px]"></i> ${timeAgoStr}</span>
                                ${canClearDueToday ? `<span class="clear-due-today-btn text-[10px] font-extrabold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-0.5 rounded-md transition" data-clear-due-id="${escapeHtml(n.id)}" title="Clear for today (will remind again tomorrow if unpaid)">Clear Today</span>` : (n.type === 'fee' && n.isRead ? `<span class="text-[10px] font-bold text-slate-400">Cleared for today</span>` : '')}
                            </div>
                        </div>
                        ${!n.isRead ? `<div class="notify-unread-dot"></div>` : ''}
                    </div>
                `;
            });
        };

        window.handleNotifyClick = async (notifId, targetStr) => {
            const notification = latestMergedNotifications.find((item) => item.id === notifId);
            if (notification && notification.type === 'fee') {
                await dismissFeeNotificationForToday([notifId]);
            } else if (notification && notification.type !== 'fee' && !notifState.readIds.includes(notifId)) {
                notifState.readIds.push(notifId);
                if (notifState.readIds.length > 200) notifState.readIds.shift();
                renderNotificationPanel();
                try {
                    await setDoc(doc(db, BASE_PATH + '/studentNotificationState', studentId), {
                        readIds: notifState.readIds
                    }, { merge: true });
                } catch(e) { console.warn('Failed to update read state', e); }
            } else {
                renderNotificationPanel();
            }

            toggleNotifyPanel(false);

            // If it is a notice or system notification, display full notice content directly inside student dashboard modal
            if (notification && (notification.type === 'notice' || targetStr === 'notice-modal')) {
                const dateBadge = notification.date
                    ? `<div class="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full mb-2"><i class="far fa-calendar-alt"></i> ${escapeHtml(notification.date)}</div>`
                    : '';
                const pinnedBadge = notification.pinned
                    ? `<span class="inline-flex items-center gap-1 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full mb-2 ml-1.5"><i class="fas fa-thumbtack"></i> Pinned</span>`
                    : '';
                const hasHeading = Boolean(notification.heading);
                const rawNoticeText = notification.rawText !== undefined ? notification.rawText : (notification.message || '');
                const hasText = Boolean(rawNoticeText);
                const hasImage = Boolean(notification.image);
                const imageBlock = hasImage
                    ? `<div class="rounded-xl overflow-hidden border border-slate-200 bg-slate-50 flex justify-center p-1"><img src="${notification.image}" alt="${escapeHtml(notification.heading || 'Notice image')}" class="max-h-[62vh] w-auto object-contain rounded-lg"></div>`
                    : '';
                const headingBlock = hasHeading
                    ? `<div class="text-base font-extrabold text-slate-900">${escapeHtml(notification.heading)}</div>`
                    : '';
                const textBlock = hasText
                    ? `<div class="text-sm text-slate-800 leading-relaxed break-words bg-slate-50 p-4 rounded-xl border border-slate-200/80">${renderNoticeTextWithLinks(rawNoticeText, 25)}</div>`
                    : (!hasImage ? `<div class="text-sm text-slate-500 italic bg-slate-50 p-4 rounded-xl border border-slate-200/80">No additional details.</div>` : '');
                const bodyHtml = `
                    <div class="space-y-3">
                        ${(dateBadge || pinnedBadge) ? `<div>${dateBadge}${pinnedBadge}</div>` : ''}
                        ${headingBlock}
                        ${imageBlock}
                        ${textBlock}
                        <div class="pt-2 flex justify-end">
                            <a href="index.html#notices" class="text-xs font-bold text-blue-600 hover:underline flex items-center gap-1">
                                <i class="fas fa-external-link-alt"></i> View All Public Notices
                            </a>
                        </div>
                    </div>
                `;
                openStudentDetailModal(notification.heading || notification.displayHeading || notification.title || 'Notice Details', bodyHtml);
                return;
            }

            if (targetStr && targetStr.includes('.html')) window.location.href = targetStr;
            else if (targetStr) activateStudentTab(targetStr);
        };

        document.getElementById('student-enable-phone-notify-btn')?.addEventListener('click', async () => {
            if (isPhoneNotificationEnabled()) {
                await disablePhoneNotifications();
            } else {
                await enablePhoneNotifications();
            }
        });

        document.getElementById('student-notify-confirm-ok')?.addEventListener('click', async () => {
            const modal = document.getElementById('student-notify-confirm-modal');
            modal?.classList.add('hidden');
            modal?.classList.remove('flex');
            await enablePhoneNotifications();
        });

        document.getElementById('student-notify-confirm-later')?.addEventListener('click', () => {
            const modal = document.getElementById('student-notify-confirm-modal');
            modal?.classList.add('hidden');
            modal?.classList.remove('flex');
            localStorage.setItem(getPhoneNotifyPromptShownKey(), '1');
            updatePhoneNotifyPermissionBanner();
        });

        // Listen for clicks or dismissals (swipe clear) from Service Worker system notifications
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data?.type === 'NOTIFICATION_CLICKED') {
                    const { notifId, target } = event.data;
                    if (notifId) {
                        window.handleNotifyClick(notifId, target || '');
                    } else if (target) {
                        activateStudentTab(target);
                    }
                } else if (event.data?.type === 'NOTIFICATION_CLOSED') {
                    const { notifId } = event.data;
                    if (notifId && String(notifId).startsWith('fee-')) {
                        dismissFeeNotificationForToday([notifId]);
                    }
                }
            });
        }

        document.getElementById('student-notify-mark-all')?.addEventListener('click', async () => {
            const nonFeeIds = latestMergedNotifications
                .filter((notification) => notification.type !== 'fee')
                .map((notification) => notification.id)
                .filter(Boolean);
            const feeIds = latestMergedNotifications
                .filter((notification) => notification.type === 'fee')
                .map((notification) => notification.id)
                .filter(Boolean);

            notifState.lastMarkedAllReadAt = Date.now();
            notifState.readIds = [...new Set([...notifState.readIds, ...nonFeeIds])].slice(-150);

            if (feeIds.length > 0) {
                await dismissFeeNotificationForToday(feeIds);
            } else {
                renderNotificationPanel();
            }

            try {
                await setDoc(doc(db, BASE_PATH + '/studentNotificationState', studentId), {
                    lastMarkedAllReadAt: notifState.lastMarkedAllReadAt,
                    readIds: notifState.readIds,
                    feeDismissedDates: notifState.feeDismissedDates || {}
                }, { merge: true });
            } catch(e) { console.warn('Failed to mark all as read', e); }
        });

        document.getElementById('student-notify-list')?.addEventListener('click', (event) => {
            const clearBtn = event.target.closest('.clear-due-today-btn');
            if (clearBtn) {
                event.preventDefault();
                event.stopPropagation();
                const clearId = clearBtn.dataset.clearDueId || '';
                if (clearId) dismissFeeNotificationForToday([clearId]);
                return;
            }
            const directLink = event.target.closest('a[href]');
            if (directLink) {
                event.stopPropagation();
                return;
            }
            const button = event.target.closest('.notify-item');
            if (!button) return;
            event.preventDefault();
            window.handleNotifyClick(button.dataset.notificationId || '', button.dataset.notificationTarget || '');
        });
        document.getElementById('student-notify-trigger')?.addEventListener('click', () => toggleNotifyPanel(true));
        document.getElementById('student-notify-close')?.addEventListener('click', () => toggleNotifyPanel(false));
        document.getElementById('student-notify-backdrop')?.addEventListener('click', () => toggleNotifyPanel(false));
        document.getElementById('student-detail-modal-close')?.addEventListener('click', () => closeStudentDetailModal());
        document.getElementById('student-detail-modal')?.addEventListener('click', (event) => {
            if (event.target?.id === 'student-detail-modal') closeStudentDetailModal();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeStudentDetailModal();
                toggleNotifyPanel(false);
            }
            if ((event.key === 'Enter' || event.key === ' ') && event.target?.classList?.contains('fee-card')) {
                event.preventDefault();
                window.openFeeDetailModal(event.target);
            }
        });
        window.triggerNotificationUpdate = () => renderNotificationPanel();

        function fitText(elementId) {
            const el = document.getElementById(elementId);
            if(!el) return;
            const parent = el.parentElement;
            el.style.fontSize = ''; 
            let fontSize = parseInt(window.getComputedStyle(el).fontSize);
            el.style.whiteSpace = 'nowrap';
            while (el.scrollWidth > parent.clientWidth && fontSize > 12) {
                fontSize -= 1;
                el.style.fontSize = fontSize + 'px';
            }
        }
        window.addEventListener('resize', () => { fitText('header-title'); });


        registerServiceWorker();
        const studentId = window.AppSession?.getStudentId?.() || '';
        let feeItems = [], allPayments = [], siblingPayments = [], studentGroups = [], allStaff = [];
        let groupMemberProfileMap = {};
        let defaultFee = 200;
        let feeCollectionConfig = {
            startDay: 1,
            endDay: 10,
            notifyMode: 'month_start',
            notifyDaysBefore: 5
        };
        let studentPortalPerms = { allowPhotoUpload: false, allowDetailsEdit: false };
        let paymentDetails = {};
        let resultSchemas = [];
        let resultCenterSettings = { locked: false, blockedClasses: [] };
        let studentPhotoSubmission = {};
        const STUDENT_DONATION_ITEM_KEY = '__student_donation__';
        const MONTH_SEQUENCE = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        let availableAcademicYears = [];
        let selectedFeeAcademicYear = '';
        let selectedResultAcademicYear = '';
        let studentProfile = null;
        let studentResultsCache = [];
        let resultCountdownTimer = null;
        let academicYearSettings = [];
        let currentAcademicYear = '';
        let sessionRegistryHeartbeat = null;
        const getStudentSessionRegistryRef = () => doc(db, `${BASE_PATH}/settings`, 'sessionRegistry');
        const getStudentDeviceId = () => {
            const key = 'fee_student_device_id';
            const existing = localStorage.getItem(key);
            if (existing) return existing;
            const generated = `stu-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
            localStorage.setItem(key, generated);
            return generated;
        };
        const updateStudentSessionRegistry = async (profile = {}) => {
            if (!studentId) return;
            const deviceId = getStudentDeviceId();
            await setDoc(getStudentSessionRegistryRef(), {
                sessions: {
                    [deviceId]: {
                        deviceId,
                        role: 'student',
                        userKey: studentId,
                        userName: profile?.name || studentId,
                        deviceLabel: navigator.userAgent.includes('Android') ? 'Android Device' : navigator.userAgent.includes('iPhone') ? 'iOS Device' : 'Browser Device',
                        platform: navigator.platform || '',
                        lastSeenAt: new Date().toISOString(),
                        forceLogout: false
                    }
                }
            }, { merge: true });
        };
        const startStudentSessionHeartbeat = (profile = {}) => {
            if (sessionRegistryHeartbeat) clearInterval(sessionRegistryHeartbeat);
            updateStudentSessionRegistry(profile).catch((error) => console.warn('Student session registry update failed.', error));
            sessionRegistryHeartbeat = setInterval(() => {
                updateStudentSessionRegistry(profile).catch((error) => console.warn('Student session registry update failed.', error));
            }, 60000);
        };
        const defaultCollectorLabel = 'School Office';
        const getCollectorPaymentContext = (classLabel = '') => {
            const normalizedClass = String(classLabel || '').trim();
            const collector = allStaff.find((staff) => {
                if (!staff || staff.isActive === false || staff.canCollect === false) return false;
                const dutyClasses = Array.isArray(staff.dutyClasses) ? staff.dutyClasses : [];
                return dutyClasses.includes(normalizedClass);
            });
            const collectorDetails = (collector && collector.dutyPaymentDetails && typeof collector.dutyPaymentDetails === 'object')
                ? collector.dutyPaymentDetails
                : {};
            const hasCollectorDetails = Object.values(collectorDetails).some((value) => String(value || '').trim() !== '');
            return {
                collectorName: collector?.name || '',
                ownerLabel: collector?.name || defaultCollectorLabel,
                details: hasCollectorDetails ? collectorDetails : paymentDetails
            };
        };
        const getPaymentDetailFields = (details = {}) => ([
            { label: 'A/C Name', value: details.accountName || details.paymentAccountName || details.upiName || '' },
            { label: 'UPI Number', value: details.upiNumber || details.paymentUpiNumber || '' },
            { label: 'UPI ID', value: details.upiId || details.paymentUpiId || '' },
            { label: 'Bank Name', value: details.bankName || details.paymentBankName || '' },
            { label: 'Account Number', value: details.accountNumber || details.paymentAccountNumber || '' },
            { label: 'IFSC Code', value: details.ifsc || details.paymentIfsc || '' },
            { label: 'Branch', value: details.branch || details.paymentBranch || '' }
        ].filter((field) => String(field.value || '').trim() !== ''));

        const renderPaymentDetailRows = (details = {}, { copyable = false } = {}) => getPaymentDetailFields(details).map((field) => `
            <div class="copy-pay-row">
                <div><span class="text-gray-500">${escapeHtml(field.label)}:</span> ${escapeHtml(field.value)}</div>
                ${copyable ? `<button class="copy-pay-detail-btn" data-copy-value="${encodeURIComponent(String(field.value))}" type="button">Copy</button>` : ''}
            </div>
        `).join('');

        const renderProfilePaymentDetails = () => {
            const container = document.getElementById('student-profile-payment-details');
            if (!container) return;
            const googlePayRows = renderPaymentDetailRows({
                accountName: paymentDetails.accountName || '',
                upiNumber: paymentDetails.upiNumber || '',
                upiId: paymentDetails.upiId || ''
            }, { copyable: true });
            const bankRows = renderPaymentDetailRows({
                bankName: paymentDetails.bankName || '',
                accountNumber: paymentDetails.accountNumber || '',
                ifsc: paymentDetails.ifsc || '',
                branch: paymentDetails.branch || ''
            }, { copyable: true });
            if (!googlePayRows && !bankRows) {
                container.classList.add('hidden');
                container.innerHTML = '';
                return;
            }
            container.classList.remove('hidden');
            container.innerHTML = `
                <div class="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4 text-left">
                    <div class="text-sm font-extrabold text-emerald-900 mb-3"><i class="fas fa-money-check-alt mr-1"></i> Payment Details</div>
                    ${googlePayRows ? `<div class="mb-3"><div class="text-[10px] font-black uppercase tracking-widest text-emerald-700 mb-1">Google Pay / UPI</div><div class="text-[11px] text-gray-700 bg-white/80 border border-emerald-100 rounded-lg p-2 space-y-1">${googlePayRows}</div></div>` : ''}
                    ${bankRows ? `<div><div class="text-[10px] font-black uppercase tracking-widest text-emerald-700 mb-1">Bank Account</div><div class="text-[11px] text-gray-700 bg-white/80 border border-emerald-100 rounded-lg p-2 space-y-1">${bankRows}</div></div>` : ''}
                </div>
            `;
        };

        const formatPublishDateTime = (value = '') => {
            if (!value) return 'Not scheduled';
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) return value;
            return parsed.toLocaleString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });
        };
        const examOrder = ['quarterly', 'halfYearly', 'annual'];
        const examLabels = { quarterly: 'Quarterly', halfYearly: 'Half-Yearly', annual: 'Annual' };
        const stringifyResultLabel = (value, fallback = 'Exam') => {
            if (typeof value === 'string' || typeof value === 'number') return String(value || fallback);
            if (value && typeof value === 'object') {
                return String(value.label || value.name || value.title || value.examLabel || value.examName || fallback);
            }
            return fallback;
        };
        const getConfiguredExamNoticeItems = (academicYear = '', classLabel = '') => {
            const schema = resultSchemas.find((item) => {
                const yearMatch = !academicYear || item.academicYear === academicYear || !item.academicYear;
                const classMatch = !classLabel || item.classLabel === classLabel || !item.classLabel;
                return yearMatch && classMatch;
            });
            const configured = schema?.examConfigs && typeof schema.examConfigs === 'object'
                ? examOrder.map((key) => ({ key, label: stringifyResultLabel(schema.examConfigs[key], examLabels[key] || key) }))
                : [];
            const items = configured.length ? configured : examOrder.map((key) => ({ key, label: examLabels[key] || key }));
            return items.slice(0, 3);
        };
        const classByYear = {};

        const getSortedAcademicYears = (years = []) => [...new Set(years.filter(Boolean))]
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const getMonthIndexFromName = (name = '') => {
            const normalized = String(name || '').trim().toLowerCase();
            const matchedMonth = MONTH_SEQUENCE.find((month) => new RegExp(`(^|[^a-z])${month}([^a-z]|$)`).test(normalized));
            return matchedMonth ? MONTH_SEQUENCE.indexOf(matchedMonth) : -1;
        };
        const formatMonthFeeCardName = (name = '') => {
            const monthIndex = getMonthIndexFromName(name);
            if (monthIndex < 0) return String(name || 'Monthly Fee');
            return MONTH_SEQUENCE[monthIndex].charAt(0).toUpperCase() + MONTH_SEQUENCE[monthIndex].slice(1);
        };
        const getAcademicYearRecord = (label = '') => academicYearSettings.find((year) => year?.label === label) || null;
        const getAcademicYearStatus = (label = '') => String(getAcademicYearRecord(label)?.status || 'active').toLowerCase();
        const isYearVisibleInStudent = (label = '') => getAcademicYearStatus(label) !== 'archived';
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
        const getStudentBaseMonthlyFee = (st = {}) => {
            if(st.concessionFee !== undefined && st.concessionFee !== null && st.concessionFee !== "") return parseFloat(st.concessionFee);
            const group = studentGroups.find(g => Array.isArray(g.memberIds) && g.memberIds.includes(studentId));
            return group && group.fee > 0 ? group.fee : defaultFee;
        };
        const getFeeItemAmount = (item = {}, classLabel = '--', baseFee = defaultFee) => {
            if(item.type === 'custom') {
                if(item.scope === 'global') return item.amount || 0;
                if(item.scope === 'class-wise' && item.classValues) return item.classValues[classLabel] || 0;
                if(item.scope === 'specific') return item.amount || 0;
            }
            return baseFee;
        };
        const getFeeYearSummary = (st = {}, academicYear = '') => {
            const classLabel = classByYear[academicYear] || st?.class || '--';
            const baseFee = getStudentBaseMonthlyFee(st);
            const currentYearFeeItems = feeItems.filter((item) => (item.academicYear || st.academicYear || '') === academicYear);
            const yearPayments = allPayments.filter((payment) => {
                const item = currentYearFeeItems.find((feeItem) => feeItem.key === payment.itemKey);
                const paymentYear = payment.academicYear || item?.academicYear || '';
                return paymentYear === academicYear;
            });
            const paymentsByItem = new Map(yearPayments.map((payment) => [payment.itemKey, payment]));
            const visibleItems = currentYearFeeItems.filter((item) => {
                if(item.isVisible === false) return false;
                if(item.key === STUDENT_DONATION_ITEM_KEY) return false;
                if(item.type === 'custom' && item.scope === 'specific' && item.targetClass !== classLabel) return false;
                return true;
            });
            const dueItems = visibleItems
                .filter((item) => !paymentsByItem.has(item.key))
                .map((item) => {
                    let dueAmount = getFeeItemAmount(item, classLabel, baseFee);
                    const isMonthly = !item.type || item.type === 'month';
                    if (isMonthly) {
                        const hasConcession = st.concessionFee !== undefined && st.concessionFee !== null && st.concessionFee !== "";
                        const siblingPaid = siblingPayments.some((sp) => sp.itemKey === item.key);
                        if (hasConcession) {
                            dueAmount = parseFloat(st.concessionFee) || defaultFee;
                        } else if (siblingPaid) {
                            dueAmount = defaultFee;
                        } else {
                            const group = studentGroups.find(g => Array.isArray(g.memberIds) && g.memberIds.includes(studentId));
                            dueAmount = group && group.fee > 0 ? group.fee : defaultFee;
                        }
                    }
                    return {
                        item,
                        name: item.name || 'Fee Item',
                        amount: dueAmount,
                        monthIndex: isMonthly ? getMonthIndexFromName(item.name) : -1
                    };
                });
            return {
                academicYear,
                totalDue: dueItems.reduce((sum, due) => sum + (Number(due.amount) || 0), 0),
                dueItems
            };
        };
        const formatOrdinalDayLabel = (day) => {
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

        const buildFeeNotificationAlerts = (st = {}) => {
            const alerts = [];
            const now = new Date();
            const nowTs = Date.now();
            const currentYear = currentAcademicYear || st?.academicYear || selectedFeeAcademicYear || '';

            if (currentYear) {
                const currentSummary = getFeeYearSummary(st, currentYear);
                const todayDate = now.getDate();
                const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

                const startDay = Math.min(daysInCurrentMonth, Math.max(1, parseInt(feeCollectionConfig.startDay, 10) || 1));
                const rawEndDay = Math.max(startDay, parseInt(feeCollectionConfig.endDay, 10) || 10);
                const effectiveEndDay = Math.min(daysInCurrentMonth, rawEndDay);
                const notifyMode = feeCollectionConfig.notifyMode || 'month_start';
                const notifyDaysBefore = Math.min(28, Math.max(1, parseInt(feeCollectionConfig.notifyDaysBefore, 10) || 5));

                let triggerDay = 1;
                if (notifyMode === 'month_start') {
                    triggerDay = 1;
                } else if (notifyMode === 'collection_start') {
                    triggerDay = startDay;
                } else if (notifyMode === 'days_before_end') {
                    triggerDay = Math.max(1, effectiveEndDay - notifyDaysBefore);
                } else if (notifyMode === 'days_before_month_end') {
                    triggerDay = Math.max(1, daysInCurrentMonth - notifyDaysBefore + 1);
                }

                const isPastCollectionWindowThisMonth = todayDate > effectiveEndDay;
                const shouldNotifyCurrentMonth = todayDate >= triggerDay || isPastCollectionWindowThisMonth;
                const windowText = `${formatOrdinalDayLabel(startDay)} to ${formatOrdinalDayLabel(effectiveEndDay)}`;

                const currentMonthDue = currentSummary.dueItems.find((due) => due.monthIndex === now.getMonth());
                if (currentMonthDue && shouldNotifyCurrentMonth) {
                    const alertTriggerDate = new Date(now.getFullYear(), now.getMonth(), triggerDay, 0, 0, 0);
                    const monthLabel = formatMonthFeeCardName(currentMonthDue.name);
                    if (isPastCollectionWindowThisMonth) {
                        alerts.push({
                            id: `fee-current-due-${currentYear}-${now.getMonth() + 1}-${currentMonthDue.item?.key || currentMonthDue.name}`,
                            type: 'fee',
                            icon: 'fa-clock',
                            title: `${monthLabel} Fee Overdue`,
                            message: `${monthLabel} fee of ${formatCurrency(currentMonthDue.amount)} is overdue (Collection window: ${windowText} of this month). Please settle it at the earliest.`,
                            timestamp: nowTs,
                            target: 'fees-page'
                        });
                    } else {
                        alerts.push({
                            id: `fee-current-due-${currentYear}-${now.getMonth() + 1}-${currentMonthDue.item?.key || currentMonthDue.name}`,
                            type: 'fee',
                            icon: 'fa-calendar-check',
                            title: `${monthLabel} Fee Due (${windowText})`,
                            message: `${monthLabel} fee of ${formatCurrency(currentMonthDue.amount)} is due for this month (Collection dates: ${windowText}). Please pay before the ${formatOrdinalDayLabel(effectiveEndDay)}.`,
                            timestamp: alertTriggerDate.getTime(),
                            target: 'fees-page'
                        });
                    }
                }

                const monthOrder = getAcademicMonthSequence(currentYear);
                const currentMonthOrderIndex = monthOrder.indexOf(now.getMonth());
                currentSummary.dueItems.forEach((due) => {
                    // Keep non-default/custom fee reminders active until they are paid.
                    if (due.monthIndex < 0) {
                        alerts.push({
                            id: `fee-custom-due-${currentYear}-${due.item?.key || due.name}`,
                            type: 'fee',
                            icon: 'fa-triangle-exclamation',
                            title: `${normalizeFeeItemName(due.name)} Pending`,
                            message: `${normalizeFeeItemName(due.name)} fee of ${formatCurrency(due.amount)} is still unpaid. Please pay it at the earliest.`,
                            timestamp: nowTs,
                            target: 'fees-page'
                        });
                        return;
                    }

                    // If monthly fee remains unpaid after that month has passed in academic order,
                    // keep showing overdue notification until settled.
                    const dueMonthOrderIndex = monthOrder.indexOf(due.monthIndex);
                    const isOverdueMonthly = currentMonthOrderIndex >= 0 && dueMonthOrderIndex >= 0 && dueMonthOrderIndex < currentMonthOrderIndex;
                    if (isOverdueMonthly) {
                        alerts.push({
                            id: `fee-overdue-${currentYear}-${due.monthIndex}-${due.item?.key || 'month'}`,
                            type: 'fee',
                            icon: 'fa-clock',
                            title: `${formatMonthFeeCardName(due.name)} Fee Overdue`,
                            message: `${formatMonthFeeCardName(due.name)} fee of ${formatCurrency(due.amount)} is overdue from previous month(s). Please clear it immediately.`,
                            timestamp: nowTs,
                            target: 'fees-page'
                        });
                    }
                });
            }
            return alerts;
        };
        const sortMonthlyItemsByAcademicYear = (items = [], academicYear = '') => {
            const monthOrder = getAcademicMonthSequence(academicYear || selectedFeeAcademicYear);
            return [...items].sort((a, b) => {
                const aName = String(a?.name || '').trim();
                const bName = String(b?.name || '').trim();
                const aOrder = monthOrder.indexOf(getMonthIndexFromName(aName));
                const bOrder = monthOrder.indexOf(getMonthIndexFromName(bName));
                if (aOrder === -1 && bOrder === -1) return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
                if (aOrder === -1) return 1;
                if (bOrder === -1) return -1;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
            });
        };
        const buildAvailableAcademicYears = (profile, payments = [], results = []) => {
            const yearsFromFeeItems = feeItems.map((item) => item.academicYear).filter(Boolean);
            const yearsFromPayments = payments.map((item) => item.academicYear).filter(Boolean);
            const yearsFromResults = results.map((item) => item.academicYear).filter(Boolean);
            const paidYears = new Set(yearsFromPayments);
            const settingsYears = academicYearSettings.map((item) => typeof item === 'string' ? item : (item?.label || item?.year)).filter(Boolean);
            const allYears = getSortedAcademicYears([currentAcademicYear, profile?.academicYear, ...settingsYears, ...yearsFromFeeItems, ...yearsFromPayments, ...yearsFromResults]);
            const filtered = allYears.filter((year) => {
                const status = getAcademicYearStatus(year);
                if (year === currentAcademicYear) return true;
                if (status === 'archived') return false;
                if (status === 'planning') return paidYears.has(year);
                return isYearVisibleInStudent(year);
            });
            return filtered.length ? filtered : [profile?.academicYear || '--'];
        };

        const updateYearNavigatorState = (prevId, nextId, currentYear) => {
            const idx = availableAcademicYears.indexOf(currentYear);
            const prevBtn = document.getElementById(prevId);
            const nextBtn = document.getElementById(nextId);
            const prevLabel = document.getElementById(prevId.replace('-btn', '-label'));
            const nextLabel = document.getElementById(nextId.replace('-btn', '-label'));
            if (prevBtn) prevBtn.disabled = idx <= 0;
            if (nextBtn) nextBtn.disabled = idx === -1 || idx >= availableAcademicYears.length - 1;
            if (prevLabel) prevLabel.textContent = idx > 0 ? availableAcademicYears[idx - 1] : '--';
            if (nextLabel) nextLabel.textContent = idx >= 0 && idx < availableAcademicYears.length - 1 ? availableAcademicYears[idx + 1] : '--';
        };
        const renderAcademicYearSelect = (selectId, activeYear) => {
            const select = document.getElementById(selectId);
            if (!select) return;
            select.innerHTML = availableAcademicYears.map((year) => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join('');
            select.value = activeYear || availableAcademicYears[0] || '';
        };
        const resolveAcademicClass = (year = '', profile = {}) => {
            if (year && classByYear[year]) return classByYear[year];
            if (year) {
                const resultMatch = (studentResultsCache || []).find((item) => (item.academicYear || '') === year && item.classLabel);
                if (resultMatch?.classLabel) return resultMatch.classLabel;
                const paymentMatch = (allPayments || []).find((item) => (item.academicYear || '') === year && (item.classLabel || item.class));
                if (paymentMatch) return paymentMatch.classLabel || paymentMatch.class;
            }
            return profile?.class || '--';
        };

        const resolveSubjectLabel = (schema, subjectKey) => {
            const normalizedKey = String(subjectKey || '').trim().toLowerCase();
            const subjects = Array.isArray(schema?.subjectRows) && schema.subjectRows.length ? schema.subjectRows : (Array.isArray(schema?.subjects) ? schema.subjects : []);
            const matchedSubject = subjects.find((subject) => {
                const code = String(subject?.code || subject?.id || '').trim().toLowerCase();
                const name = typeof subject === 'string' ? subject.trim().toLowerCase() : String(subject?.name || '').trim().toLowerCase();
                return normalizedKey === code || normalizedKey === name;
            });
            return (typeof matchedSubject === 'string' ? matchedSubject : matchedSubject?.name) || subjectKey || '--';
        };
        const displayResultMark = (mark) => {
            if (mark && typeof mark === 'object') return String(mark.value ?? mark.mark ?? '-');
            return String(mark ?? '-');
        };
        const normalizeFeeItemDisplayName = (name = '') => String(name || '').replace(/\s*\((?:\d{4}\s*-\s*\d{2,4}|\d{4}\s*-\s*\d{4})\)\s*$/i, '').trim();
        const computeDisplayGrade = (markValue, subjectMax = 100) => {
            const raw = String(markValue ?? '').trim();
            const num = Number(raw);
            if (!Number.isFinite(num)) return raw || '-';
            const scale = Number(resultCenterSettings.gradeScaleTotal || 100) === 50 ? 50 : 100;
            const score = (num / Math.max(1, Number(subjectMax || 100))) * scale;
            const rules = Array.isArray(resultCenterSettings.gradeRules) ? resultCenterSettings.gradeRules : [];
            const matched = rules.find((rule) => score >= Number(rule.min || 0) && score <= Number(rule.max || 0));
            if (matched?.grade) return matched.grade;
            if (scale === 50) return score >= 45 ? 'A+' : score >= 40 ? 'A' : score >= 30 ? 'B' : score >= 18 ? 'C' : 'F';
            return score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 35 ? 'C' : 'F';
        };
        const getStudentGender = (st = {}) => {
            const raw = String(st?.gender || st?.profile?.gender || st?.sex || '').trim().toLowerCase();
            if (raw.startsWith('f') || raw === 'girl' || raw.includes('fem') || raw.includes('പെൺ') || raw.includes('സ്ത്രീ')) {
                return 'female';
            }
            return 'male';
        };

        const getStudentInitial = (st = {}) => {
            const raw = String(st?.name || st?.profile?.name || '').trim();
            return (raw.charAt(0) || 'S').toUpperCase();
        };

        const getStudentAvatarDataUrl = (st = {}) => {
            const initial = getStudentInitial(st);
            const initialSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <defs>
    <linearGradient id="initGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e3a8a"/>
      <stop offset="50%" stop-color="#172554"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <circle cx="60" cy="60" r="57" fill="url(#initGrad)" stroke="#f59e0b" stroke-width="3"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="'Plus Jakarta Sans', system-ui, -apple-system, sans-serif" font-size="54" font-weight="900" fill="#ffffff">${initial}</text>
</svg>`;
            return `data:image/svg+xml;utf8,${encodeURIComponent(initialSvg)}`;
        };

        const loadPosterImage = (src) => new Promise((resolve) => {
            if (!src) return resolve(null);
            const img = new Image();
            let done = false;
            img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve(null);
                }
            }, 3000);
            img.onload = () => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(img);
                }
            };
            img.onerror = () => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(null);
                }
            };
            img.src = src;
        });

        const drawRoundedRect = (ctx, x, y, width, height, radius, fillStyle = null, strokeStyle = null, lineWidth = 1) => {
            ctx.save();
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(x, y, width, height, radius);
            } else {
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + width - radius, y);
                ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
                ctx.lineTo(x + width, y + height - radius);
                ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
                ctx.lineTo(x + radius, y + height);
                ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
                ctx.lineTo(x, y + radius);
                ctx.quadraticCurveTo(x, y, x + radius, y);
            }
            ctx.closePath();
            if (fillStyle) {
                ctx.fillStyle = fillStyle;
                ctx.fill();
            }
            if (strokeStyle) {
                ctx.strokeStyle = strokeStyle;
                ctx.lineWidth = lineWidth;
                ctx.stroke();
            }
            ctx.restore();
        };

        const syncResultTabVisibility = (showResults = false) => {
            const navItem = document.getElementById('results-nav-item');
            const bottomBtn = document.getElementById('results-bottom-btn');
            navItem?.classList.remove('hidden');
            bottomBtn?.classList.remove('hidden');
        };

        const getStudentResultExamKey = (result = {}) => result.examType || result.examKey || String(result.examId || '').split('::').pop() || '';
        const getStudentResultSchema = (result = {}, activeYear = '') => resultSchemas.find((item) => item.id === result.schemaId)
            || resultSchemas.find((item) => item.academicYear === (result.academicYear || activeYear) && item.classLabel === result.classLabel)
            || resultSchemas.find((item) => item.classLabel === result.classLabel);
        const getStudentResultExamLabel = (result = {}) => {
            const examKey = getStudentResultExamKey(result);
            const schema = getStudentResultSchema(result, result.academicYear || '');
            return result.examLabel || schema?.examConfigs?.[examKey]?.label || examLabels[examKey] || examKey || result.examId || 'Exam';
        };

        // Canvas drawing helpers for Colourful Annual Result Certificate
        const drawMortarboardCap = (ctx, cx, cy, scale = 1) => {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(scale, scale);
            ctx.rotate(-15 * Math.PI / 180);

            // Skullcap base
            ctx.beginPath();
            ctx.ellipse(0, 10, 24, 12, 0, 0, Math.PI);
            ctx.fillStyle = '#0f172a';
            ctx.fill();

            // Mortarboard Diamond Top
            ctx.beginPath();
            ctx.moveTo(0, -22);
            ctx.lineTo(48, -4);
            ctx.lineTo(0, 14);
            ctx.lineTo(-48, -4);
            ctx.closePath();
            const topGrad = ctx.createLinearGradient(-48, -22, 48, 14);
            topGrad.addColorStop(0, '#1e293b');
            topGrad.addColorStop(0.5, '#0f172a');
            topGrad.addColorStop(1, '#020617');
            ctx.fillStyle = topGrad;
            ctx.fill();
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Golden center button
            ctx.beginPath();
            ctx.arc(0, -4, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#f59e0b';
            ctx.fill();

            // Golden Tassel Ribbon hanging left
            ctx.beginPath();
            ctx.moveTo(0, -4);
            ctx.bezierCurveTo(-18, -12, -32, 10, -38, 28);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Tassel fringe at end
            ctx.beginPath();
            ctx.moveTo(-42, 28);
            ctx.lineTo(-34, 28);
            ctx.lineTo(-32, 46);
            ctx.lineTo(-44, 46);
            ctx.closePath();
            ctx.fillStyle = '#d97706';
            ctx.fill();

            ctx.restore();
        };

        const drawBotanicalLeaves = (ctx, startX, startY, controlX, controlY, endX, endY, color = '#15803d') => {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.quadraticCurveTo(controlX, controlY, endX, endY);
            ctx.stroke();

            // Draw small leaves along stem
            const leafSteps = [0.2, 0.4, 0.6, 0.8, 1.0];
            leafSteps.forEach((t, i) => {
                const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * controlX + t * t * endX;
                const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * controlY + t * t * endY;
                const angle = Math.atan2(endY - startY, endX - startX) + (i % 2 === 0 ? 0.7 : -0.7);
                
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(angle);
                ctx.beginPath();
                ctx.ellipse(10, 0, 11, 5, 0, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.restore();
            });
            ctx.restore();
        };

        const drawPaperPlane = (ctx, x, y, size = 30) => {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(15 * Math.PI / 180);

            // Dashed trail loop
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(-60, 40);
            ctx.bezierCurveTo(-40, 60, -30, 20, -10, 10);
            ctx.stroke();
            ctx.setLineDash([]);

            // Plane Body
            ctx.beginPath();
            ctx.moveTo(size, 0);
            ctx.lineTo(-size, -size * 0.5);
            ctx.lineTo(-size * 0.4, 0);
            ctx.closePath();
            ctx.fillStyle = '#60a5fa';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(size, 0);
            ctx.lineTo(-size * 0.4, 0);
            ctx.lineTo(-size, size * 0.5);
            ctx.closePath();
            ctx.fillStyle = '#93c5fd';
            ctx.fill();
            ctx.restore();
        };

        const drawOpenBookDoodle = (ctx, x, y, size = 36) => {
            ctx.save();
            ctx.strokeStyle = '#cbd5e1';
            ctx.lineWidth = 2;
            ctx.beginPath();
            // Left page
            ctx.moveTo(x, y + size * 0.4);
            ctx.quadraticCurveTo(x - size * 0.5, y + size * 0.1, x - size, y + size * 0.3);
            ctx.lineTo(x - size, y - size * 0.3);
            ctx.quadraticCurveTo(x - size * 0.5, y - size * 0.5, x, y - size * 0.2);
            // Right page
            ctx.quadraticCurveTo(x + size * 0.5, y - size * 0.5, x + size, y - size * 0.3);
            ctx.lineTo(x + size, y + size * 0.3);
            ctx.quadraticCurveTo(x + size * 0.5, y + size * 0.1, x, y + size * 0.4);
            ctx.stroke();
            // Center spine
            ctx.beginPath();
            ctx.moveTo(x, y - size * 0.2);
            ctx.lineTo(x, y + size * 0.4);
            ctx.stroke();
            ctx.restore();
        };

        const drawDoodleStar = (ctx, cx, cy, spikes = 5, outerRadius = 14, innerRadius = 6, color = '#f59e0b') => {
            ctx.save();
            let rot = Math.PI / 2 * 3;
            let step = Math.PI / spikes;
            ctx.beginPath();
            ctx.moveTo(cx, cy - outerRadius);
            for (let i = 0; i < spikes; i++) {
                let x = cx + Math.cos(rot) * outerRadius;
                let y = cy + Math.sin(rot) * outerRadius;
                ctx.lineTo(x, y);
                rot += step;
                x = cx + Math.cos(rot) * innerRadius;
                y = cy + Math.sin(rot) * innerRadius;
                ctx.lineTo(x, y);
                rot += step;
            }
            ctx.lineTo(cx, cy - outerRadius);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.restore();
        };

        const drawStackedBooks = (ctx, x, y, w = 120, h = 90) => {
            ctx.save();
            // Bottom Book (Deep Navy)
            drawRoundedRect(ctx, x, y + 54, w, 28, 4, '#1e3a8a', '#172554', 1.5);
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(x + 12, y + 58, w - 16, 20); // pages

            // Middle Book (White/Ivory)
            drawRoundedRect(ctx, x + 6, y + 26, w - 10, 26, 4, '#f1f5f9', '#cbd5e1', 1.5);
            ctx.fillStyle = '#e2e8f0';
            ctx.fillRect(x + 16, y + 30, w - 24, 18);

            // Top Book (Rich Blue with orange bookmark)
            drawRoundedRect(ctx, x - 2, y, w - 8, 24, 4, '#0284c7', '#0369a1', 1.5);
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(x + 10, y + 4, w - 24, 16);

            // Hanging orange bookmark
            ctx.beginPath();
            ctx.moveTo(x + 40, y + 16);
            ctx.lineTo(x + 50, y + 16);
            ctx.lineTo(x + 50, y + 46);
            ctx.lineTo(x + 45, y + 40);
            ctx.lineTo(x + 40, y + 46);
            ctx.closePath();
            ctx.fillStyle = '#ea580c';
            ctx.fill();
            ctx.restore();
        };

        const drawRosetteSeal = (ctx, cx, cy, radius = 32, isPass = true) => {
            ctx.save();
            const petalCount = 16;
            const step = (Math.PI * 2) / petalCount;
            const primaryColor = isPass ? '#15803d' : '#dc2626';
            const deepColor = isPass ? '#166534' : '#b91c1c';

            // Scalloped outer petals
            ctx.beginPath();
            for (let i = 0; i < petalCount; i++) {
                const angle = i * step;
                const px = cx + Math.cos(angle) * (radius - 2);
                const py = cy + Math.sin(angle) * (radius - 2);
                ctx.arc(px, py, radius * 0.28, 0, Math.PI * 2);
            }
            ctx.fillStyle = primaryColor;
            ctx.fill();

            // Inner circle
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.88, 0, Math.PI * 2);
            ctx.fillStyle = deepColor;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Icon: Bold Checkmark or Cross
            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 4.5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            if (isPass) {
                ctx.moveTo(cx - (radius * 0.38), cy);
                ctx.lineTo(cx - (radius * 0.1), cy + (radius * 0.32));
                ctx.lineTo(cx + (radius * 0.42), cy - (radius * 0.35));
            } else {
                ctx.moveTo(cx - (radius * 0.3), cy - (radius * 0.3));
                ctx.lineTo(cx + (radius * 0.3), cy + (radius * 0.3));
                ctx.moveTo(cx + (radius * 0.3), cy - (radius * 0.3));
                ctx.lineTo(cx - (radius * 0.3), cy + (radius * 0.3));
            }
            ctx.stroke();
            ctx.restore();

            ctx.restore();
        };

        const drawAuthenticTrophy = (ctx, cx, cy, size = 44) => {
            ctx.save();
            const half = size / 2;
            const goldGrad = ctx.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
            goldGrad.addColorStop(0, '#f59e0b');
            goldGrad.addColorStop(0.5, '#d97706');
            goldGrad.addColorStop(1, '#b45309');

            // 1. Cup Chalice Body
            ctx.beginPath();
            const topW = size * 0.58;
            const cupTopY = cy - (size * 0.42);
            const cupH = size * 0.44;
            ctx.moveTo(cx - (topW / 2), cupTopY);
            ctx.lineTo(cx + (topW / 2), cupTopY);
            ctx.bezierCurveTo(
                cx + (topW / 2), cupTopY + (cupH * 0.6),
                cx + (size * 0.16), cupTopY + cupH,
                cx, cupTopY + cupH
            );
            ctx.bezierCurveTo(
                cx - (size * 0.16), cupTopY + cupH,
                cx - (topW / 2), cupTopY + (cupH * 0.6),
                cx - (topW / 2), cupTopY
            );
            ctx.fillStyle = goldGrad;
            ctx.fill();

            // Rim highlight
            ctx.beginPath();
            ctx.ellipse(cx, cupTopY, topW / 2, size * 0.06, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#fbbf24';
            ctx.fill();

            // 2. Twin Ear Handles (Left & Right)
            ctx.lineWidth = Math.max(2.5, size * 0.08);
            ctx.strokeStyle = '#d97706';
            ctx.lineCap = 'round';

            // Left Handle
            ctx.beginPath();
            ctx.moveTo(cx - (topW * 0.46), cupTopY + (size * 0.06));
            ctx.bezierCurveTo(
                cx - (size * 0.48), cupTopY + (size * 0.06),
                cx - (size * 0.48), cupTopY + (size * 0.32),
                cx - (size * 0.16), cupTopY + (size * 0.35)
            );
            ctx.stroke();

            // Right Handle
            ctx.beginPath();
            ctx.moveTo(cx + (topW * 0.46), cupTopY + (size * 0.06));
            ctx.bezierCurveTo(
                cx + (size * 0.48), cupTopY + (size * 0.06),
                cx + (size * 0.48), cupTopY + (size * 0.32),
                cx + (size * 0.16), cupTopY + (size * 0.35)
            );
            ctx.stroke();

            // 3. Slender Stem
            const stemY = cupTopY + cupH;
            const stemH = size * 0.16;
            ctx.fillStyle = '#b45309';
            ctx.fillRect(cx - (size * 0.06), stemY, size * 0.12, stemH);

            // Stem ring
            ctx.fillStyle = '#f59e0b';
            ctx.beginPath();
            ctx.ellipse(cx, stemY + (stemH * 0.5), size * 0.1, size * 0.04, 0, 0, Math.PI * 2);
            ctx.fill();

            // 4. Two-Tier Pedestal Base
            const base1Y = stemY + stemH;
            const base1W = size * 0.42;
            const base1H = size * 0.1;
            ctx.fillStyle = '#d97706';
            ctx.fillRect(cx - (base1W / 2), base1Y, base1W, base1H);

            const base2Y = base1Y + base1H;
            const base2W = size * 0.62;
            const base2H = size * 0.12;
            ctx.fillStyle = '#92400e';
            ctx.fillRect(cx - (base2W / 2), base2Y, base2W, base2H);

            // Subtle highlight on cup
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(cx - (size * 0.1), cupTopY + (size * 0.14), size * 0.04, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        };

        const drawStudentInitialDirect = (ctx, x, y, w, h, initial = 'S') => {
            ctx.save();
            const cx = x + (w / 2);
            const cy = y + (h / 2);
            const r = Math.min(w, h) / 2;

            const grad = ctx.createLinearGradient(x, y, x + w, y + h);
            grad.addColorStop(0, '#1e3a8a');
            grad.addColorStop(1, '#0f172a');
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.lineWidth = 3;
            ctx.strokeStyle = '#f59e0b';
            ctx.stroke();

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.font = `900 ${Math.round(r * 0.95)}px "Plus Jakarta Sans", Arial, sans-serif`;
            ctx.fillText(String(initial || 'S').toUpperCase(), cx, cy);
            ctx.restore();
        };

        const buildResultPosterBlob = async (result, cardEl = null) => {
            const conf = window.institutionConfig || {};
            const activeYear = result.academicYear || studentProfile?.academicYear || selectedResultAcademicYear || '--';
            const schema = getStudentResultSchema(result, activeYear);
            const examKey = getStudentResultExamKey(result);
            const rawExamLabel = getStudentResultExamLabel(result);
            const examLabel = stringifyResultLabel(rawExamLabel, examLabels[examKey] || examKey || 'Exam');
            const classLabel = result.classLabel || studentProfile?.class || '--';
            const studentName = studentProfile?.name || 'Student';
            const studentGender = getStudentGender(studentProfile);
            const fatherName = String(studentProfile?.father || studentProfile?.profile?.father || '').trim();
            const relPrefix = studentGender === 'female' ? 'D/o' : 'S/o';

            const photoSrc = studentProfile?.photo || result.photo || '';
            const hasPhoto = Boolean(photoSrc);

            const visibilityKey = `${classLabel}__${examKey}`;
            const rawVisibility = resultCenterSettings.resultVisibilityMap?.[visibilityKey];
            const visibility = rawVisibility && typeof rawVisibility === 'object'
                ? { marks: rawVisibility.marks !== false, grades: rawVisibility.grades !== false }
                : { marks: rawVisibility !== false, grades: rawVisibility !== false };
            const examConfigShowMarks = schema?.examConfigs?.[examKey]?.showMarksToStudents === true;
            const showMarks = result.showMarksToStudents === false
                ? false
                : (visibility.marks && (result.showMarksToStudents === true || examConfigShowMarks));
            const showGrades = visibility.grades !== false;

            const subjectKeys = Object.keys(result.grades || result.marks || {});
            const subjectCount = Math.max(1, subjectKeys.length);

            // Dynamic heights calculation based on subject count & photo presence
            const designWidth = 960;
            const rowHeight = 62;
            const tableHeadHeight = 56;
            const tableHeight = tableHeadHeight + (subjectCount * rowHeight);
            const headerSectionHeight = fatherName ? 425 : 395;
            const metricSectionHeight = 125;
            const statusSectionHeight = 92;
            const footerSectionHeight = 115;
            const gapY = 24;

            const designHeight = headerSectionHeight + gapY + tableHeight + gapY + metricSectionHeight + gapY + statusSectionHeight + footerSectionHeight;
            const pixelRatio = 2;

            const canvas = document.createElement('canvas');
            canvas.width = designWidth * pixelRatio;
            canvas.height = designHeight * pixelRatio;
            canvas.style.width = `${designWidth}px`;
            canvas.style.height = `${designHeight}px`;
            const ctx = canvas.getContext('2d');
            ctx.scale(pixelRatio, pixelRatio);

            // 1. Luxurious Warm Canvas Background
            const bgGrad = ctx.createLinearGradient(0, 0, 0, designHeight);
            bgGrad.addColorStop(0, '#fffdf9');
            bgGrad.addColorStop(1, '#fcf7ee');
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, designWidth, designHeight);

            // Outer delicate frame
            drawRoundedRect(ctx, 16, 16, designWidth - 32, designHeight - 32, 28, null, '#f1ede4', 2);

            // 2. Corner Ribbons & Decorative Swirls
            // Top-Left Royal Blue Wave
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(240, 0);
            ctx.bezierCurveTo(210, 75, 120, 150, 0, 175);
            ctx.closePath();
            const tlGrad = ctx.createLinearGradient(0, 0, 180, 160);
            tlGrad.addColorStop(0, '#172554');
            tlGrad.addColorStop(0.6, '#1e3a8a');
            tlGrad.addColorStop(1, '#0f172a');
            ctx.fillStyle = tlGrad;
            ctx.fill();

            // Top-Left Gold Ribbon Accent
            ctx.beginPath();
            ctx.moveTo(240, 0);
            ctx.bezierCurveTo(210, 75, 120, 150, 0, 175);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 5;
            ctx.stroke();

            // Leaf sprigs along top left wave
            drawBotanicalLeaves(ctx, 30, 110, 75, 170, 40, 240, '#16a34a');
            ctx.restore();

            // Top-Right Swirl & Doodles
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(designWidth, 0);
            ctx.lineTo(designWidth - 190, 0);
            ctx.bezierCurveTo(designWidth - 120, 70, designWidth - 60, 120, designWidth, 140);
            ctx.closePath();
            ctx.fillStyle = '#1e3a8a';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(designWidth - 190, 0);
            ctx.bezierCurveTo(designWidth - 120, 70, designWidth - 60, 120, designWidth, 140);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.restore();

            // Doodles: Stars, Open Book, Paper Plane
            drawDoodleStar(ctx, designWidth - 85, 50, 5, 15, 6, '#f59e0b');
            drawDoodleStar(ctx, designWidth - 160, 75, 4, 8, 4, '#fbbf24');
            drawOpenBookDoodle(ctx, designWidth - 110, 40, 28);
            drawPaperPlane(ctx, designWidth - 65, 175, 24);

            // 3. Top Heading: RESULT (Large, Regal, Centered)
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#172554';
            ctx.font = '900 52px "Plus Jakarta Sans", "Georgia", sans-serif';
            ctx.fillText('RESULT', designWidth / 2, 68);

            // 4. Exam Name (Subtitle under RESULT)
            const examTitleUpper = String(examLabel || 'ANNUAL EXAMINATION').toUpperCase();
            ctx.fillStyle = '#d97706';
            ctx.font = '800 20px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(examTitleUpper, designWidth / 2, 104);
            ctx.restore();

            // 5. Profile Photo Card / Initial Badge (Centered)
            const photoCardSize = 140;
            const photoCardX = (designWidth - photoCardSize) / 2;
            const photoCardY = 126;
            const photoRadius = 22;

            // Card background & subtle shadow
            drawRoundedRect(ctx, photoCardX, photoCardY, photoCardSize, photoCardSize, photoRadius, '#ffffff', '#e2e8f0', 1.5);

            // Stitched dashed inner ring
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = '#cbd5e1';
            ctx.lineWidth = 1.5;
            drawRoundedRect(ctx, photoCardX + 6, photoCardY + 6, photoCardSize - 12, photoCardSize - 12, 16, null, '#cbd5e1', 1.5);
            ctx.setLineDash([]);
            ctx.restore();

            // Inner photo container
            const innerPhotoX = photoCardX + 10;
            const innerPhotoY = photoCardY + 10;
            const innerPhotoSize = photoCardSize - 20;
            const innerPhotoRadius = 14;

            ctx.save();
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(innerPhotoX, innerPhotoY, innerPhotoSize, innerPhotoSize, innerPhotoRadius);
            } else {
                ctx.rect(innerPhotoX, innerPhotoY, innerPhotoSize, innerPhotoSize);
            }
            ctx.clip();

            if (hasPhoto) {
                let profileImg = await loadPosterImage(photoSrc);
                if (profileImg) {
                    const pw = profileImg.width || 1;
                    const ph = profileImg.height || 1;
                    const minDim = Math.min(pw, ph);
                    const sx = (pw - minDim) / 2;
                    const sy = (ph - minDim) / 2;
                    ctx.drawImage(profileImg, sx, sy, minDim, minDim, innerPhotoX, innerPhotoY, innerPhotoSize, innerPhotoSize);
                } else {
                    drawStudentInitialDirect(ctx, innerPhotoX, innerPhotoY, innerPhotoSize, innerPhotoSize, studentInitial);
                }
            } else {
                drawStudentInitialDirect(ctx, innerPhotoX, innerPhotoY, innerPhotoSize, innerPhotoSize, studentInitial);
            }
            ctx.restore();

            // Graduation Cap (Mortarboard) on bottom-left corner of photo
            drawMortarboardCap(ctx, photoCardX + 4, photoCardY + photoCardSize - 8, 0.88);

            // Botanical sprig accent beside photo
            drawBotanicalLeaves(ctx, photoCardX + photoCardSize + 6, photoCardY + 70, photoCardX + photoCardSize + 30, photoCardY + 100, photoCardX + photoCardSize + 12, photoCardY + 130, '#15803d');

            // 6. Student Name (Centered under photo)
            const studentNameY = photoCardY + photoCardSize + 36;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.fillStyle = '#0f172a';
            ctx.font = '900 30px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(studentName.toUpperCase(), designWidth / 2, studentNameY);

            // 7. Parent Name (Centered under student name)
            let currentHeaderY = studentNameY;
            if (fatherName) {
                currentHeaderY += 26;
                ctx.font = '700 17px "Plus Jakarta Sans", Arial, sans-serif';
                ctx.fillStyle = '#475569';
                ctx.fillText(`${relPrefix} ${fatherName.toUpperCase()}`, designWidth / 2, currentHeaderY);
            }

            // 8. Class Box on the same line (Centered under parent name)
            currentHeaderY += 26;
            const cleanClassNo = String(classLabel || '').replace(/class\s*[-:]?\s*/i, '').trim() || String(classLabel || '');
            const classBoxPrefix = 'CLASS : ';
            ctx.font = '900 17px "Plus Jakarta Sans", Arial, sans-serif';
            const prefixWidth = ctx.measureText(classBoxPrefix).width;
            const classNumWidth = ctx.measureText(cleanClassNo).width;
            const totalClassTextWidth = prefixWidth + classNumWidth;

            const classBoxPadX = 22;
            const classBoxW = Math.max(160, totalClassTextWidth + (classBoxPadX * 2));
            const classBoxH = 38;
            const classBoxX = (designWidth - classBoxW) / 2;
            const classBoxY = currentHeaderY;

            // Draw crisp rounded box
            drawRoundedRect(ctx, classBoxX, classBoxY, classBoxW, classBoxH, 12, '#ffffff', '#172554', 2);

            // Draw CLASS : and Number on the same line inside the box
            ctx.textBaseline = 'middle';
            const classTextStartX = (designWidth - totalClassTextWidth) / 2;
            ctx.textAlign = 'left';
            ctx.fillStyle = '#d97706';
            ctx.fillText(classBoxPrefix, classTextStartX, classBoxY + (classBoxH / 2));
            ctx.fillStyle = '#172554';
            ctx.fillText(cleanClassNo, classTextStartX + prefixWidth, classBoxY + (classBoxH / 2));
            ctx.restore();

            // 6. Main Subject Table
            const tableX = 65;
            const tableW = designWidth - 130;
            const tableY = headerSectionHeight + 10;

            // Table Header Bar (Teal / Dark Cyan Gradient)
            const headGrad = ctx.createLinearGradient(tableX, tableY, tableX + tableW, tableY + tableHeadHeight);
            headGrad.addColorStop(0, '#0b6685');
            headGrad.addColorStop(1, '#0e5a77');
            drawRoundedRect(ctx, tableX, tableY, tableW, tableHeadHeight, [18, 18, 0, 0], headGrad, null);

            ctx.fillStyle = '#ffffff';
            ctx.font = '900 19px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('SUBJECT', tableX + 45, tableY + 34);

            ctx.textAlign = 'center';
            ctx.fillText('MARK', tableX + (tableW * 0.58), tableY + 34);
            ctx.fillText('GRADE', tableX + (tableW * 0.84), tableY + 34);

            // Table Body Container
            drawRoundedRect(ctx, tableX, tableY + tableHeadHeight, tableW, subjectCount * rowHeight, [0, 0, 18, 18], '#ffffff', '#e2e8f0', 1.5);

            let currentRowY = tableY + tableHeadHeight;
            let totalObtainedMarks = 0;
            let totalMaxMarks = 0;

            subjectKeys.forEach((key, idx) => {
                const markObj = result.marks?.[key];
                const markValue = displayResultMark(markObj);
                const maxVal = Number(markObj?.maxMarks || 100);
                const gradeValue = computeDisplayGrade(markValue, maxVal);
                const isFailed = String(gradeValue).trim().toUpperCase() === 'F' || String(markObj?.status || '').toUpperCase() === 'FAIL';

                const numObtained = Number(markValue);
                if (Number.isFinite(numObtained)) {
                    totalObtainedMarks += numObtained;
                    totalMaxMarks += maxVal;
                }

                // Row divider
                if (idx > 0) {
                    ctx.strokeStyle = '#f1f5f9';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(tableX + 15, currentRowY);
                    ctx.lineTo(tableX + tableW - 15, currentRowY);
                    ctx.stroke();
                }

                // Subject Name
                ctx.textAlign = 'left';
                ctx.fillStyle = '#0f172a';
                ctx.font = '800 20px "Plus Jakarta Sans", Arial, sans-serif';
                const subjectTitle = resolveSubjectLabel(schema, key).toUpperCase();
                ctx.fillText(subjectTitle, tableX + 45, currentRowY + 38);

                // Marks Column
                ctx.textAlign = 'center';
                ctx.font = '800 22px "Plus Jakarta Sans", Arial, sans-serif';
                ctx.fillStyle = isFailed ? '#dc2626' : '#0f172a';
                const markDisplay = showMarks ? (markValue || '-') : '-';
                ctx.fillText(String(markDisplay), tableX + (tableW * 0.58), currentRowY + 38);

                // Grade Column - Lilac Rounded Pill Badge
                if (showGrades) {
                    const pillW = 120;
                    const pillH = 40;
                    const pillX = tableX + (tableW * 0.84) - (pillW / 2);
                    const pillY = currentRowY + ((rowHeight - pillH) / 2);
                    drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 12, '#ede9fe', null);

                    ctx.fillStyle = isFailed ? '#dc2626' : '#7c3aed';
                    ctx.font = '900 22px "Plus Jakarta Sans", Arial, sans-serif';
                    ctx.fillText(String(gradeValue || '-'), tableX + (tableW * 0.84), currentRowY + 38);
                }

                currentRowY += rowHeight;
            });

            // 7. Three Metric Cards: Total, Rank, Attendance
            const metricY = currentRowY + gapY;
            const metricCardW = (tableW - 32) / 3;
            const metricCardH = metricSectionHeight;

            const displayTotObtained = result.totals?.obtained ?? (totalObtainedMarks || '-');
            const displayTotMax = result.totals?.maximum ?? (totalMaxMarks || '-');
            const rankRows = (studentResultsCache || [])
                .filter((item) => getStudentResultExamKey(item) === examKey)
                .sort((a, b) => Number(b.totals?.obtained || 0) - Number(a.totals?.obtained || 0));
            const currentRank = rankRows.findIndex((row) => row.studentId === result.studentId) + 1;
            const attendanceText = `${result.attendance?.presentDays ?? 82}/${result.attendance?.workingDays ?? 90}`;

            // Card 1: Total (Light Sky Blue)
            const c1X = tableX;
            drawRoundedRect(ctx, c1X, metricY, metricCardW, metricCardH, 18, '#e0f2fe', '#bae6fd', 1.5);
            // Drawn Bar Chart Icon
            ctx.fillStyle = '#0284c7';
            ctx.fillRect(c1X + 28, metricY + 68, 8, 24);
            ctx.fillRect(c1X + 40, metricY + 54, 8, 38);
            ctx.fillRect(c1X + 52, metricY + 60, 8, 32);

            ctx.textAlign = 'left';
            ctx.fillStyle = '#475569';
            ctx.font = '700 16px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText('Total', c1X + 74, metricY + 52);
            ctx.fillStyle = '#0f172a';
            ctx.font = '900 28px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(`${displayTotObtained}/${displayTotMax}`, c1X + 74, metricY + 86);

            // Card 2: Rank (Light Warm Yellow)
            const c2X = tableX + metricCardW + 16;
            drawRoundedRect(ctx, c2X, metricY, metricCardW, metricCardH, 18, '#fef9c3', '#fef08a', 1.5);
            // Drawn Authentic Trophy Icon
            drawAuthenticTrophy(ctx, c2X + 44, metricY + 68, 44);

            ctx.fillStyle = '#475569';
            ctx.font = '700 16px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText('Rank', c2X + 78, metricY + 52);
            ctx.fillStyle = '#0f172a';
            ctx.font = '900 32px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(currentRank > 0 ? String(currentRank) : '1', c2X + 74, metricY + 86);

            // Card 3: Attendance (Light Rose)
            const c3X = tableX + (metricCardW + 16) * 2;
            drawRoundedRect(ctx, c3X, metricY, metricCardW, metricCardH, 18, '#ffe4e6', '#fecdd3', 1.5);
            // Drawn Calendar Icon
            drawRoundedRect(ctx, c3X + 28, metricY + 52, 30, 32, 6, '#ffffff', '#e11d48', 2);
            ctx.fillStyle = '#e11d48';
            ctx.fillRect(c3X + 28, metricY + 52, 30, 10);
            // grid dots
            ctx.fillStyle = '#e11d48';
            ctx.fillRect(c3X + 34, metricY + 68, 4, 4);
            ctx.fillRect(c3X + 44, metricY + 68, 4, 4);
            ctx.fillRect(c3X + 34, metricY + 75, 4, 4);
            ctx.fillRect(c3X + 44, metricY + 75, 4, 4);

            ctx.fillStyle = '#475569';
            ctx.font = '700 16px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText('Attendance', c3X + 72, metricY + 52);
            ctx.fillStyle = '#0f172a';
            ctx.font = '900 28px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(attendanceText, c3X + 72, metricY + 86);

            // 8. Large Prominent PASS / Status Banner
            const statusY = metricY + metricCardH + gapY;
            const passStatus = result.totals?.passStatus || (result.totals?.status || 'PASS');
            const isPass = passStatus === 'PASS';

            drawRoundedRect(ctx, tableX, statusY, tableW, statusSectionHeight, 22, isPass ? '#dcfce7' : '#fee2e2', isPass ? '#86efac' : '#fca5a5', 1.5);

            // Sparkle rays left and right of seal
            drawDoodleStar(ctx, tableX + (tableW * 0.32), statusY + (statusSectionHeight / 2) - 14, 4, 8, 3, isPass ? '#16a34a' : '#dc2626');
            drawDoodleStar(ctx, tableX + (tableW * 0.30), statusY + (statusSectionHeight / 2) + 14, 4, 6, 2, isPass ? '#22c55e' : '#ef4444');
            drawDoodleStar(ctx, tableX + (tableW * 0.68), statusY + (statusSectionHeight / 2) - 14, 4, 8, 3, isPass ? '#16a34a' : '#dc2626');
            drawDoodleStar(ctx, tableX + (tableW * 0.70), statusY + (statusSectionHeight / 2) + 14, 4, 6, 2, isPass ? '#22c55e' : '#ef4444');

            // Green Rosette Seal Badge
            drawRosetteSeal(ctx, tableX + (tableW * 0.38), statusY + (statusSectionHeight / 2), 28, isPass);

            // Big Bold Status Text
            ctx.textAlign = 'left';
            ctx.fillStyle = isPass ? '#064e3b' : '#991b1b';
            ctx.font = '900 44px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(passStatus, tableX + (tableW * 0.44), statusY + (statusSectionHeight / 2) + 15);

            // 9. Bottom Footer with Institution Details (Logo, Name, Reg No, Place)
            const bottomY = designHeight - 85;

            // Left bottom botanical leaves accent
            drawBotanicalLeaves(ctx, 25, bottomY - 15, 75, bottomY + 15, 35, bottomY + 50, '#15803d');
            // Right bottom botanical leaves accent
            drawBotanicalLeaves(ctx, designWidth - 75, bottomY - 15, designWidth - 25, bottomY + 15, designWidth - 35, bottomY + 50, '#15803d');

            // Bottom sweeping royal blue & gold ribbon
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(0, designHeight);
            ctx.lineTo(0, designHeight - 75);
            ctx.bezierCurveTo(240, designHeight - 95, 520, designHeight - 55, designWidth, designHeight - 75);
            ctx.lineTo(designWidth, designHeight);
            ctx.closePath();
            const bottomGrad = ctx.createLinearGradient(0, designHeight - 85, 0, designHeight);
            bottomGrad.addColorStop(0, '#172554');
            bottomGrad.addColorStop(1, '#0f172a');
            ctx.fillStyle = bottomGrad;
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0, designHeight - 75);
            ctx.bezierCurveTo(240, designHeight - 95, 520, designHeight - 55, designWidth, designHeight - 75);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.restore();

            // Load and draw Institution Logo, Name, Reg No, and Place
            const headerLogoEl = document.getElementById('header-logo');
            const instLogoSrc = conf.logo || conf.logoUrl || headerLogoEl?.getAttribute('src') || 'assets/images/logo.png';
            const instLogoImg = await loadPosterImage(instLogoSrc);

            const instName = conf.institutionName || conf.appName || document.getElementById('id-school-name')?.textContent?.trim() || 'NOORUL ISLAM HIGHER SECONDARY MADRASA';
            const rawReg = conf.regNo || conf.regNumber || conf.registrationNumber || document.getElementById('header-regno')?.textContent?.trim() || '';
            const cleanRegNo = String(rawReg).replace(/^(reg(istration)?\s*(no)?[:.]*\s*)+/gi, '').trim();
            const place = conf.place || conf.location || conf.address || document.getElementById('header-place')?.textContent?.trim() || '';
            let regAndPlace = '';
            if (cleanRegNo && place) {
                regAndPlace = `Reg: ${cleanRegNo}  •  ${place}`;
            } else if (cleanRegNo) {
                regAndPlace = `Reg: ${cleanRegNo}`;
            } else if (place) {
                regAndPlace = place;
            }

            ctx.save();
            ctx.font = '900 18px "Plus Jakarta Sans", Arial, sans-serif';
            const instNameWidth = ctx.measureText(instName.toUpperCase()).width;
            ctx.font = '700 13px "Plus Jakarta Sans", Arial, sans-serif';
            const regWidth = regAndPlace ? ctx.measureText(regAndPlace).width : 0;
            const textWidth = Math.max(instNameWidth, regWidth);

            const logoSize = 44;
            const logoGap = 16;
            const totalFooterWidth = (instLogoImg ? (logoSize + logoGap) : 0) + textWidth;
            const footerStartX = Math.max(30, (designWidth - totalFooterWidth) / 2);
            const footerCenterY = designHeight - 38;

            if (instLogoImg) {
                const logoX = footerStartX;
                const logoY = footerCenterY - (logoSize / 2);
                ctx.save();
                ctx.beginPath();
                ctx.arc(logoX + (logoSize / 2), footerCenterY, (logoSize / 2) + 2, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.clip();
                ctx.drawImage(instLogoImg, logoX, logoY, logoSize, logoSize);
                ctx.restore();
            }

            const footerTextStartX = footerStartX + (instLogoImg ? (logoSize + logoGap) : 0);
            ctx.textAlign = 'left';
            ctx.fillStyle = '#ffffff';
            ctx.font = '900 18px "Plus Jakarta Sans", Arial, sans-serif';
            ctx.fillText(instName.toUpperCase(), footerTextStartX, regAndPlace ? (footerCenterY - 4) : (footerCenterY + 6));

            if (regAndPlace) {
                ctx.fillStyle = '#fde68a';
                ctx.font = '700 13px "Plus Jakarta Sans", Arial, sans-serif';
                ctx.fillText(regAndPlace, footerTextStartX, footerCenterY + 16);
            }
            ctx.restore();

            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            if (!blob) throw new Error('Failed to generate image blob');
            return blob;
        };

        const buildAlhamdulillahShareText = (_result) => {
            return 'Alhamdulillah';
        };

        const downloadRankPoster = async (result, cardEl = null) => {
            const blob = await buildResultPosterBlob(result, cardEl);
            const studentName = studentProfile?.name || 'student';
            const examKey = getStudentResultExamKey(result) || 'exam';
            const anchor = document.createElement('a');
            anchor.href = URL.createObjectURL(blob);
            anchor.download = `result_poster_${studentName.replace(/\s+/g, '_')}_${examKey}.png`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(anchor.href), 1500);
        };

        const shareRankPoster = async (result, cardEl = null) => {
            const blob = await buildResultPosterBlob(result, cardEl);
            const studentName = studentProfile?.name || 'student';
            const examLabel = stringifyResultLabel(getStudentResultExamLabel(result), 'Exam');
            const examKey = getStudentResultExamKey(result) || 'exam';
            const fileName = `result_poster_${studentName.replace(/\s+/g, '_')}_${examKey}.png`;
            const imageFile = new File([blob], fileName, { type: 'image/png' });
            const shareText = buildAlhamdulillahShareText(result);

            if (navigator.share && navigator.canShare?.({ files: [imageFile] })) {
                try {
                    await navigator.share({
                        title: `${studentName} - ${examLabel}`,
                        text: shareText,
                        files: [imageFile]
                    });
                    return;
                } catch (e) {
                    if (e.name !== 'AbortError') console.warn('Share error', e);
                }
            }

            // Fallback for desktop or non-sharing devices
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(shareText);
                alert('Alhamdulillah! Caption copied to clipboard. Poster image downloaded.');
            }
            const anchor = document.createElement('a');
            anchor.href = URL.createObjectURL(blob);
            anchor.download = fileName;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(anchor.href), 1500);
        };

        const shareRankPosterWhatsApp = async (result, cardEl = null) => {
            const shareText = buildAlhamdulillahShareText(result);
            downloadRankPoster(result, cardEl).catch((e) => console.warn(e));
            const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
            window.open(waUrl, '_blank');
        };

        const renderStudentResults = (profile, results = [], targetYear = '') => {
            try {
                const activeYear = targetYear || profile?.academicYear || '--';
                const classLabel = resolveAcademicClass(activeYear, profile);
                document.getElementById('results-year-label').textContent = `Academic Year: ${activeYear}`;
                document.getElementById('results-class-label').textContent = `Class: ${classLabel}`;
                renderAcademicYearSelect('results-year-select', activeYear);

                const container = document.getElementById('results-container');
                if (resultCountdownTimer) {
                    clearInterval(resultCountdownTimer);
                    resultCountdownTimer = null;
                }
                if (resultCenterSettings.blockedClasses?.includes(classLabel)) {
                    container.innerHTML = buildEmptyState('Result visibility is temporarily blocked for your class.', 'fa-eye-slash');
                    return;
                }

                const filteredResults = results.filter((result) => (result.academicYear || profile?.academicYear || '') === activeYear);
                const examSelect = document.getElementById('results-exam-select');
                // Build list of specific exams ONLY - strict prohibition on any 'All Exams' option
                const examOptions = [...new Set(filteredResults.map((result) => getStudentResultExamKey(result)))].filter(Boolean);
                
                if (examSelect) {
                    if (examOptions.length > 0) {
                        const prev = examOptions.includes(examSelect.value) ? examSelect.value : examOptions[examOptions.length - 1];
                        examSelect.innerHTML = examOptions.map((exam) => {
                            const rawLabel = getStudentResultExamLabel(filteredResults.find((row) => getStudentResultExamKey(row) === exam) || { examKey: exam });
                            const label = stringifyResultLabel(rawLabel, examLabels[exam] || exam);
                            return `<option value="${escapeHtml(exam)}">${escapeHtml(label)}</option>`;
                        }).join('');
                        examSelect.value = prev;
                    } else {
                        examSelect.innerHTML = '<option value="">No Exams Published</option>';
                    }
                }

                // Whichever specific exam is selected, ONLY that specific exam's result is displayed
                const selectedExam = examSelect?.value || (examOptions[examOptions.length - 1] || '');
                const examScopedResults = selectedExam ? filteredResults.filter((result) => getStudentResultExamKey(result) === selectedExam) : [];
                
                const publishTs = resultCenterSettings.publishAt ? new Date(resultCenterSettings.publishAt).getTime() : 0;
                const shouldShowCountdown = Number.isFinite(publishTs) && publishTs > Date.now() && !filteredResults.length;
                const formatCountdown = (remainingMs) => {
                    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
                    const days = Math.floor(totalSeconds / 86400);
                    const hours = Math.floor((totalSeconds % 86400) / 3600);
                    const minutes = Math.floor((totalSeconds % 3600) / 60);
                    const seconds = totalSeconds % 60;
                    const lead = days > 0 ? `${days}d ` : '';
                    return `${lead}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                };
                if (resultCenterSettings.locked === true || shouldShowCountdown) {
                    const publishAtLabel = formatPublishDateTime(resultCenterSettings.publishAt);
                    const examLabel = resultCenterSettings.examLabel || 'Upcoming Exam';
                    container.innerHTML = `
                        <div class="result-countdown-card">
                            <div class="result-countdown-head">
                                <div class="result-countdown-icon"><i class="fas fa-hourglass-half"></i></div>
                                <span class="result-countdown-exam">${escapeHtml(examLabel)}</span>
                            </div>
                            <h3 class="result-countdown-title">Results will be published soon</h3>
                            <p class="result-countdown-subtitle">Scheduled publish time: <strong>${escapeHtml(publishAtLabel)}</strong></p>
                            <div id="results-publish-countdown" class="result-countdown-time">--:--:--</div>
                            <p class="result-countdown-note">Please check again after the countdown ends.</p>
                        </div>
                    `;
                    const countdownEl = document.getElementById('results-publish-countdown');
                    const tick = () => {
                        if (!countdownEl) return;
                        if (!Number.isFinite(publishTs) || publishTs <= 0) {
                            countdownEl.textContent = 'Updating soon';
                            return;
                        }
                        const remaining = publishTs - Date.now();
                        countdownEl.textContent = remaining > 0 ? formatCountdown(remaining) : 'Publishing now...';
                    };
                    tick();
                    if (Number.isFinite(publishTs) && publishTs > Date.now()) resultCountdownTimer = setInterval(tick, 1000);
                    return;
                }

                if (!examScopedResults.length) {
                    const headerLogo = document.getElementById('header-logo')?.getAttribute('src') || '';
                    const logo = sanitizeUrl(headerLogo) || 'assets/images/logo.png';
                    const noticeItems = getConfiguredExamNoticeItems(activeYear, classLabel);
                    container.innerHTML = `
                        <div class="rounded-2xl border border-indigo-100 bg-gradient-to-b from-white to-indigo-50/60 px-5 py-8 text-center shadow-sm">
                            <img src="${escapeHtml(logo)}" class="mx-auto h-24 w-24 object-contain mb-4 opacity-90" alt="Institution Logo" onerror="this.src='assets/images/logo.png'">
                            <h3 class="text-lg font-extrabold text-indigo-900 mb-2">Results will be published here</h3>
                            <p class="text-sm font-semibold text-slate-600 leading-relaxed max-w-md mx-auto">
                                ${escapeHtml(activeYear)} academic year results have not been published yet. After each exam is completed, these exam results will be available here.
                            </p>
                            <div class="mt-5 grid gap-2 sm:grid-cols-3">
                                ${noticeItems.map((exam, index) => `
                                    <div class="rounded-xl border border-indigo-100 bg-white px-3 py-3 shadow-sm">
                                        <div class="text-[10px] font-black uppercase tracking-wider text-indigo-400">Exam ${index + 1}</div>
                                        <div class="mt-1 text-sm font-extrabold text-indigo-800">${escapeHtml(exam.label)} Exam Result</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>`;
                    return;
                }

                // Render single chosen exam's colourful certificate view
                const cards = examScopedResults.map((result) => {
                    const schema = getStudentResultSchema(result, activeYear);
                    const examKey = getStudentResultExamKey(result);
                    const visibilityKey = `${result.classLabel || classLabel}__${examKey}`;
                    const rawVisibility = resultCenterSettings.resultVisibilityMap?.[visibilityKey];
                    const visibility = rawVisibility && typeof rawVisibility === 'object'
                        ? { marks: rawVisibility.marks !== false, grades: rawVisibility.grades !== false }
                        : { marks: rawVisibility !== false, grades: rawVisibility !== false };
                    const examConfigShowMarks = schema?.examConfigs?.[examKey]?.showMarksToStudents === true;
                    const showMarks = result.showMarksToStudents === false
                        ? false
                        : (visibility.marks && (result.showMarksToStudents === true || examConfigShowMarks));
                    const showGrades = visibility.grades;
                    const subjectKeys = Object.keys(result.grades || result.marks || {});
                    const rankRows = filteredResults
                        .filter((item) => getStudentResultExamKey(item) === examKey)
                        .sort((a, b) => Number(b.totals?.obtained || 0) - Number(a.totals?.obtained || 0));
                    const currentRank = rankRows.findIndex((row) => row.studentId === result.studentId) + 1;
                    
                    const studentGender = getStudentGender(studentProfile);
                    const relPrefix = studentGender === 'female' ? 'D/o' : 'S/o';
                    const fatherVal = String(studentProfile?.father || studentProfile?.profile?.father || '').trim();
                    const studentInitial = getStudentInitial(studentProfile);
                    const hasStudentPhoto = Boolean(studentProfile?.photo);
                    const cleanClassNo = String(result.classLabel || classLabel || '').replace(/class\s*[-:]?\s*/i, '').trim() || String(result.classLabel || classLabel || '');

                    const conf = window.institutionConfig || {};
                    const headerLogoEl = document.getElementById('header-logo');
                    const instLogoSrc = conf.logo || conf.logoUrl || headerLogoEl?.getAttribute('src') || 'assets/images/logo.png';
                    const instName = conf.institutionName || conf.appName || document.getElementById('id-school-name')?.textContent?.trim() || 'NOORUL ISLAM HIGHER SECONDARY MADRASA';
                    const rawReg = conf.regNo || conf.regNumber || conf.registrationNumber || document.getElementById('header-regno')?.textContent?.trim() || '';
                    const cleanRegNo = String(rawReg).replace(/^(reg(istration)?\s*(no)?[:.]*\s*)+/gi, '').trim();
                    const place = conf.place || conf.location || conf.address || document.getElementById('header-place')?.textContent?.trim() || '';
                    let regAndPlace = '';
                    if (cleanRegNo && place) {
                        regAndPlace = `Reg: ${cleanRegNo}  •  ${place}`;
                    } else if (cleanRegNo) {
                        regAndPlace = `Reg: ${cleanRegNo}`;
                    } else if (place) {
                        regAndPlace = place;
                    }

                    const examTitle = stringifyResultLabel(getStudentResultExamLabel(result), 'Annual Exam');
                    const isPass = result.totals?.passStatus === 'PASS';

                    const tableRows = subjectKeys.map((key) => {
                        const markValue = displayResultMark(result.marks?.[key]);
                        const gradeValue = computeDisplayGrade(markValue, Number(result.marks?.[key]?.maxMarks || 100));
                        const isFailed = String(gradeValue).trim().toUpperCase() === 'F' || String(result.marks?.[key]?.status || '').trim().toUpperCase() === 'FAIL';
                        return `
                        <tr class="border-b border-slate-100 hover:bg-slate-50/50 transition">
                            <td class="py-3 px-4 text-sm font-extrabold text-slate-900">${escapeHtml(resolveSubjectLabel(schema, key).toUpperCase())}</td>
                            ${showMarks ? `<td class="py-3 px-4 text-center text-sm font-extrabold ${isFailed ? 'text-red-600' : 'text-slate-900'}">${escapeHtml(markValue || '-')}</td>` : ''}
                            ${showGrades ? `
                            <td class="py-3 px-4 text-center">
                                <span class="inline-block px-3 py-1 rounded-xl text-xs font-black ${isFailed ? 'bg-red-50 text-red-600' : 'bg-purple-50 text-purple-700 border border-purple-100'} shadow-2xs">
                                    ${escapeHtml(gradeValue || '-')}
                                </span>
                            </td>` : ''}
                        </tr>
                    `;
                    }).join('');

                    return `
                        <div class="rounded-3xl border border-amber-200/60 bg-gradient-to-b from-[#fffefc] to-[#fbf7ee] p-4 sm:p-7 mb-6 shadow-lg relative overflow-hidden">
                            <!-- Top Decorative Corner Ribbon Motif -->
                            <div class="absolute top-0 left-0 w-32 h-32 bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-950 rounded-br-full -z-0 opacity-90"></div>
                            <div class="absolute top-0 left-0 w-36 h-36 border-b-4 border-amber-400 rounded-br-full pointer-events-none"></div>

                            <!-- Top Action Bar (Buttons at top) -->
                            <div class="relative z-10 flex flex-wrap items-center justify-between gap-3 pb-4 mb-5 border-b border-amber-200/50">
                                <div class="flex items-center gap-2">
                                    <span class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-950 text-amber-400 rounded-xl text-xs font-black tracking-wider uppercase border border-amber-400/40 shadow-xs">
                                        <i class="fas fa-award"></i>
                                        <span>Official Result</span>
                                    </span>
                                    <span class="text-xs font-bold text-slate-500">${escapeHtml(activeYear)}</span>
                                </div>
                                <div class="flex items-center gap-2 w-full sm:w-auto">
                                    <button class="poster-download-btn flex-1 sm:flex-none px-3.5 py-2 bg-blue-900 hover:bg-blue-950 text-white rounded-xl text-xs font-bold transition shadow-md flex items-center justify-center gap-2" data-exam="${escapeHtml(examKey)}" title="Download Colourful Poster">
                                        <i class="fas fa-download text-amber-400"></i>
                                        <span>Poster</span>
                                    </button>
                                    <button class="poster-share-btn flex-1 sm:flex-none px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-md flex items-center justify-center gap-2" data-exam="${escapeHtml(examKey)}" title="Share Result with Alhamdulillah">
                                        <i class="fas fa-share-alt"></i>
                                        <span>Share</span>
                                    </button>
                                    <button class="poster-wa-btn flex-1 sm:flex-none px-3.5 py-2 bg-green-500 hover:bg-green-600 text-white rounded-xl text-xs font-bold transition shadow-md flex items-center justify-center gap-2" data-exam="${escapeHtml(examKey)}" title="Share on WhatsApp">
                                        <i class="fab fa-whatsapp"></i>
                                        <span>WhatsApp</span>
                                    </button>
                                </div>
                            </div>

                            <!-- Centered Vertical Hierarchy:
                                 1. Large RESULT Heading
                                 2. Exam Name
                                 3. Profile Photo or Initial Badge
                                 4. Student Name
                                 5. Parent Name
                                 6. Class in a single-line Box
                            -->
                            <div class="relative z-10 flex flex-col items-center text-center mb-6">
                                <!-- 1. Large RESULT Heading -->
                                <h2 class="text-3xl sm:text-4xl font-black text-blue-950 tracking-wider font-serif uppercase leading-tight">RESULT</h2>

                                <!-- 2. Exam Name -->
                                <p class="text-xs sm:text-sm font-extrabold uppercase tracking-widest text-amber-600 mt-1">${escapeHtml(examTitle)}</p>

                                <!-- 3. Profile Photo or Initial Badge -->
                                <div class="relative mt-4 w-32 h-32 sm:w-36 sm:h-36 shrink-0">
                                    ${hasStudentPhoto ? `
                                        <div class="w-full h-full bg-white rounded-2xl p-1.5 shadow-md border-2 border-dashed border-slate-300 flex items-center justify-center">
                                            <img src="${escapeHtml(studentProfile.photo)}" class="w-full h-full rounded-xl object-cover bg-slate-100" alt="Student">
                                        </div>
                                    ` : `
                                        <div class="w-full h-full rounded-2xl bg-gradient-to-br from-blue-900 via-indigo-950 to-slate-900 text-white flex items-center justify-center font-black text-4xl sm:text-5xl shadow-md border-2 border-amber-400">
                                            ${escapeHtml(studentInitial)}
                                        </div>
                                    `}
                                    <!-- Mortarboard Badge Icon -->
                                    <div class="absolute -bottom-2.5 -left-2.5 bg-slate-900 text-amber-400 w-9 h-9 rounded-xl flex items-center justify-center shadow-lg border-2 border-amber-400 text-base">
                                        <i class="fas fa-graduation-cap"></i>
                                    </div>
                                </div>

                                <!-- 4. Student Name -->
                                <h3 class="mt-3.5 text-xl sm:text-2xl font-black text-slate-900 uppercase tracking-tight">${escapeHtml(studentProfile?.name || 'Student')}</h3>

                                <!-- 5. Parent Name -->
                                ${fatherVal ? `<p class="text-xs sm:text-sm font-bold text-slate-500 mt-0.5">${escapeHtml(relPrefix)} ${escapeHtml(fatherVal.toUpperCase())}</p>` : ''}

                                <!-- 6. Class Box on the same line -->
                                <div class="mt-2.5 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl border-2 border-blue-950 bg-white shadow-2xs">
                                    <span class="text-xs sm:text-sm font-black text-amber-600 uppercase tracking-wider">CLASS :</span>
                                    <span class="text-xs sm:text-sm font-black text-blue-950 uppercase tracking-wider">${escapeHtml(cleanClassNo)}</span>
                                </div>
                            </div>

                            <!-- Subject Table (Dark Cyan / Teal Header Bar) -->
                            <div class="relative z-10 bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs mb-5">
                                <table class="w-full text-left">
                                    <thead>
                                        <tr class="bg-gradient-to-r from-[#0b6685] to-[#0e5a77] text-white text-xs font-black uppercase tracking-wider">
                                            <th class="py-3.5 px-4">Subject</th>
                                            ${showMarks ? '<th class="py-3.5 px-4 text-center">Mark</th>' : ''}
                                            ${showGrades ? '<th class="py-3.5 px-4 text-center">Grade</th>' : ''}
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-slate-100">
                                        ${tableRows || '<tr><td class="py-4 text-center text-sm text-slate-500" colspan="3">No subject-wise entries.</td></tr>'}
                                    </tbody>
                                </table>
                            </div>

                            <!-- 3 Pastel Metric Cards: Total, Rank, Attendance -->
                            <div class="relative z-10 grid grid-cols-3 gap-2 sm:gap-3 mb-5 text-center">
                                <div class="bg-sky-50 border border-sky-200 rounded-2xl p-3 shadow-2xs">
                                    <div class="text-sky-600 text-base mb-0.5"><i class="fas fa-chart-simple"></i></div>
                                    <div class="text-[11px] font-bold text-slate-500 uppercase">Total</div>
                                    <div class="text-sm sm:text-base font-black text-slate-900 mt-0.5">${escapeHtml(String(result.totals?.obtained ?? '-'))}/${escapeHtml(String(result.totals?.maximum ?? '-'))}</div>
                                </div>
                                <div class="bg-amber-50 border border-amber-200 rounded-2xl p-3 shadow-2xs">
                                    <div class="text-amber-500 text-base mb-0.5"><i class="fas fa-trophy"></i></div>
                                    <div class="text-[11px] font-bold text-slate-500 uppercase">Rank</div>
                                    <div class="text-sm sm:text-base font-black text-slate-900 mt-0.5">${currentRank > 0 ? currentRank : '1'}</div>
                                </div>
                                <div class="bg-rose-50 border border-rose-200 rounded-2xl p-3 shadow-2xs">
                                    <div class="text-rose-500 text-base mb-0.5"><i class="fas fa-calendar-check"></i></div>
                                    <div class="text-[11px] font-bold text-slate-500 uppercase">Attendance</div>
                                    <div class="text-sm sm:text-base font-black text-slate-900 mt-0.5">${escapeHtml(String(result.attendance?.presentDays ?? 82))}/${escapeHtml(String(result.attendance?.workingDays ?? 90))}</div>
                                </div>
                            </div>

                            <!-- Large Prominent Mint-Green PASS Banner -->
                            <div class="relative z-10 rounded-2xl p-3.5 sm:p-4 text-center font-black tracking-widest flex items-center justify-center gap-3 ${isPass ? 'bg-emerald-100/90 text-emerald-900 border border-emerald-300' : 'bg-red-100 text-red-900 border border-red-300'} shadow-xs">
                                <div class="w-8 h-8 rounded-full ${isPass ? 'bg-emerald-600' : 'bg-red-600'} text-white flex items-center justify-center text-sm shadow-xs">
                                    <i class="fas ${isPass ? 'fa-check' : 'fa-times'}"></i>
                                </div>
                                <span class="text-xl sm:text-2xl">${escapeHtml(result.totals?.passStatus || 'PASS')}</span>
                            </div>

                            <!-- Bottom Footer Ribbon with Institution Details, Logo, Reg & Place -->
                            <div class="mt-5 pt-3.5 border-t border-amber-200/50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                                <div class="flex items-center gap-2.5 min-w-0">
                                    ${instLogoSrc ? `<img src="${escapeHtml(instLogoSrc)}" class="w-8 h-8 rounded-full object-contain bg-white border border-slate-200 p-0.5 shrink-0" alt="Logo" onerror="this.style.display='none'">` : ''}
                                    <div class="flex flex-col text-left min-w-0">
                                        <span class="font-extrabold text-blue-950 text-xs sm:text-sm uppercase tracking-wide truncate">${escapeHtml(instName)}</span>
                                        ${regAndPlace ? `<span class="text-[11px] font-bold text-slate-500">${escapeHtml(regAndPlace)}</span>` : ''}
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 shrink-0 ml-auto">
                                    <span class="italic font-serif font-bold text-blue-900 text-xs sm:text-sm">Alhamdulillah</span>
                                    <span class="font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200/60 text-[11px]">Official Result Report</span>
                                </div>
                            </div>
                        </div>
                    `;
                });

                container.innerHTML = cards.join('');

                // Hook up Download, Share, and WhatsApp actions
                container.querySelectorAll('.poster-download-btn').forEach((button) => {
                    button.addEventListener('click', () => {
                        button.classList.add('animate-pulse');
                        const examType = button.dataset.exam;
                        const result = examScopedResults.find((row) => getStudentResultExamKey(row) === examType);
                        if (result) downloadRankPoster(result, button.closest('.rounded-3xl')).catch((error) => console.warn('Download failed', error));
                        setTimeout(() => button.classList.remove('animate-pulse'), 1200);
                    });
                });

                container.querySelectorAll('.poster-share-btn').forEach((button) => {
                    button.addEventListener('click', async () => {
                        button.classList.add('animate-pulse');
                        const examType = button.dataset.exam;
                        const result = examScopedResults.find((row) => getStudentResultExamKey(row) === examType);
                        if (result) {
                            try {
                                await shareRankPoster(result, button.closest('.rounded-3xl'));
                            } catch (error) {
                                console.warn('Share failed', error);
                            }
                        }
                        setTimeout(() => button.classList.remove('animate-pulse'), 1200);
                    });
                });

                container.querySelectorAll('.poster-wa-btn').forEach((button) => {
                    button.addEventListener('click', async () => {
                        button.classList.add('animate-pulse');
                        const examType = button.dataset.exam;
                        const result = examScopedResults.find((row) => getStudentResultExamKey(row) === examType);
                        if (result) {
                            shareRankPosterWhatsApp(result, button.closest('.rounded-3xl'));
                        }
                        setTimeout(() => button.classList.remove('animate-pulse'), 1200);
                    });
                });

            } catch (error) {
                console.error('Failed to render student results', error);
                const container = document.getElementById('results-container');
                if (container) container.innerHTML = buildEmptyState('Unable to load results. Please refresh and try again.', 'fa-exclamation-triangle');
            }
        };
        let activeCropImg = null;
        let cropZoom = 1;
        let cropPanX = 0;
        let cropPanY = 0;
        let cameraStream = null;
        let studentCameraFacingMode = 'user';

        const startStudentCamera = async (facingMode = 'user') => {
            const video = document.getElementById('student-camera-video');
            if (!video) return false;
            if (cameraStream) {
                cameraStream.getTracks().forEach(track => track.stop());
                cameraStream = null;
            }
            studentCameraFacingMode = facingMode;
            try {
                let stream = null;
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            facingMode: { ideal: facingMode },
                            width: { ideal: 720 },
                            height: { ideal: 720 },
                            aspectRatio: { ideal: 1 }
                        }
                    });
                } catch (e1) {
                    try {
                        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
                    } catch (e2) {
                        stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    }
                }
                cameraStream = stream;
                video.srcObject = cameraStream;
                await video.play();
                return true;
            } catch (err) {
                console.warn('Camera access unavailable:', err?.message || err);
                const cameraModal = document.getElementById('student-camera-modal');
                if (cameraModal) {
                    cameraModal.classList.add('hidden');
                    cameraModal.classList.remove('flex');
                }
                const fileInput = document.getElementById('student-photo-file-input');
                if (fileInput) {
                    fileInput.setAttribute('capture', 'user');
                    fileInput.click();
                    setTimeout(() => fileInput.removeAttribute('capture'), 1000);
                }
                return false;
            }
        };

        const drawStudentCropCanvas = () => {
            const canvas = document.getElementById('student-crop-canvas');
            if (!canvas || !activeCropImg) return;
            const size = canvas.width || 200;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);

            const imgW = activeCropImg.width || 1;
            const imgH = activeCropImg.height || 1;
            // Cover scale so the image fills the 1:1 square at 1.0x zoom
            const baseScale = Math.max(size / imgW, size / imgH);
            const drawWidth = imgW * baseScale * cropZoom;
            const drawHeight = imgH * baseScale * cropZoom;

            const xOffset = (size - drawWidth) / 2 + (cropPanX * drawWidth / 100);
            const yOffset = (size - drawHeight) / 2 + (cropPanY * drawHeight / 100);

            ctx.drawImage(activeCropImg, xOffset, yOffset, drawWidth, drawHeight);
        };

        const setupStudentPhotoActions = () => {
            const fileInput = document.getElementById('student-photo-file-input');
            const cameraBtn = document.getElementById('student-photo-camera-btn');
            
            if (fileInput) {
                fileInput.addEventListener('change', (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                        const topModal = document.getElementById('student-edit-top-modal');
                        if (topModal) {
                            topModal.classList.add('hidden');
                            topModal.classList.remove('flex');
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                            const img = new Image();
                            img.onload = () => {
                                activeCropImg = img;
                                cropZoom = 1;
                                cropPanX = 0;
                                cropPanY = 0;
                                document.getElementById('student-crop-zoom').value = 1;
                                document.getElementById('student-crop-panx').value = 0;
                                document.getElementById('student-crop-pany').value = 0;
                                document.getElementById('student-zoom-label').textContent = '1.0x';
                                document.getElementById('student-crop-modal').classList.remove('hidden');
                                document.getElementById('student-crop-modal').classList.add('flex');
                                drawStudentCropCanvas();
                            };
                            img.src = reader.result;
                        };
                        reader.readAsDataURL(file);
                    }
                    e.target.value = '';
                });
            }

            if (cameraBtn) {
                cameraBtn.addEventListener('click', async () => {
                    const topModal = document.getElementById('student-edit-top-modal');
                    if (topModal) {
                        topModal.classList.add('hidden');
                        topModal.classList.remove('flex');
                    }
                    const modal = document.getElementById('student-camera-modal');
                    const ok = await startStudentCamera('user');
                    if (ok && modal) {
                        modal.classList.remove('hidden');
                        modal.classList.add('flex');
                    }
                });
            }

            // Camera control button bindings
            document.getElementById('student-camera-flip-btn')?.addEventListener('click', async () => {
                const nextMode = studentCameraFacingMode === 'user' ? 'environment' : 'user';
                await startStudentCamera(nextMode);
            });
            document.getElementById('student-camera-close-btn')?.addEventListener('click', stopStudentCamera);
            document.getElementById('student-camera-cancel-btn')?.addEventListener('click', stopStudentCamera);
            document.getElementById('student-camera-capture-btn')?.addEventListener('click', () => {
                const video = document.getElementById('student-camera-video');
                if (!video) return;
                const vw = video.videoWidth || 640;
                const vh = video.videoHeight || 640;
                const squareSide = Math.min(vw, vh);
                const sx = Math.max(0, (vw - squareSide) / 2);
                const sy = Math.max(0, (vh - squareSide) / 2);

                const canvas = document.createElement('canvas');
                canvas.width = 600;
                canvas.height = 600;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, sx, sy, squareSide, squareSide, 0, 0, 600, 600);
                stopStudentCamera();

                const img = new Image();
                img.onload = () => {
                    activeCropImg = img;
                    cropZoom = 1;
                    cropPanX = 0;
                    cropPanY = 0;
                    document.getElementById('student-crop-zoom').value = 1;
                    document.getElementById('student-crop-panx').value = 0;
                    document.getElementById('student-crop-pany').value = 0;
                    document.getElementById('student-zoom-label').textContent = '1.0x';
                    document.getElementById('student-crop-modal').classList.remove('hidden');
                    document.getElementById('student-crop-modal').classList.add('flex');
                    drawStudentCropCanvas();
                };
                img.src = canvas.toDataURL('image/jpeg', 0.92);
            });

            // Crop modal control bindings
            document.getElementById('student-crop-close-btn')?.addEventListener('click', () => {
                document.getElementById('student-crop-modal').classList.add('hidden');
                document.getElementById('student-crop-modal').classList.remove('flex');
            });
            document.getElementById('student-crop-cancel-btn')?.addEventListener('click', () => {
                document.getElementById('student-crop-modal').classList.add('hidden');
                document.getElementById('student-crop-modal').classList.remove('flex');
            });

            const zoomInput = document.getElementById('student-crop-zoom');
            const panXInput = document.getElementById('student-crop-panx');
            const panYInput = document.getElementById('student-crop-pany');

            zoomInput?.addEventListener('input', (e) => {
                cropZoom = parseFloat(e.target.value);
                document.getElementById('student-zoom-label').textContent = cropZoom.toFixed(1) + 'x';
                drawStudentCropCanvas();
            });
            panXInput?.addEventListener('input', (e) => {
                cropPanX = parseInt(e.target.value);
                drawStudentCropCanvas();
            });
            panYInput?.addEventListener('input', (e) => {
                cropPanY = parseInt(e.target.value);
                drawStudentCropCanvas();
            });

            document.getElementById('student-crop-save-btn')?.addEventListener('click', async () => {
                const canvas = document.getElementById('student-crop-canvas');
                if (!canvas) return;
                let quality = 0.9;
                let base64 = canvas.toDataURL('image/jpeg', quality);

                // Compress base64 size to strictly under 50KB (approx 50 * 1024 bytes)
                while (base64.length * 0.75 > 50 * 1024 && quality > 0.1) {
                    quality -= 0.1;
                    base64 = canvas.toDataURL('image/jpeg', quality);
                }

                // If still over 50KB, scale down resolution iteratively
                let currentWidth = 200;
                let currentHeight = 200;
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

                document.getElementById('student-crop-modal').classList.add('hidden');
                document.getElementById('student-crop-modal').classList.remove('flex');

                // Render updated image on UI immediately with circular progress ring
                document.getElementById('dash-avatar').innerHTML = `<img src="${base64}" class="w-full h-full object-cover rounded-full" alt="Profile Photo">`;
                const progressCtrl = startAvatarCircularProgress();

                try {
                    progressCtrl.setProgress(35);
                    // Save under student document in 'students' collection
                    const studentDocRef = doc(db, `${BASE_PATH}/students`, studentId);
                    const studentSnap = await getDoc(studentDocRef);
                    progressCtrl.setProgress(65);
                    if (studentSnap.exists()) {
                        const stData = studentSnap.data();
                        const updatedProfile = { ...(stData.profile || {}), photo: base64 };
                        await setDoc(studentDocRef, {
                            photo: base64,
                            profile: updatedProfile
                        }, { merge: true });
                    }

                    progressCtrl.setProgress(88);
                    // Also save under studentPhotoSubmissions/{studentId} for redundancy
                    await setDoc(doc(db, `${BASE_PATH}/studentPhotoSubmissions`, studentId), {
                        photo: base64,
                        updatedAt: Date.now()
                    }, { merge: true });

                    await progressCtrl.complete();
                    document.getElementById('dash-avatar').innerHTML = `<img src="${base64}" class="w-full h-full object-cover rounded-full" alt="Profile Photo">`;
                    const viewerImgEl = document.getElementById('student-photo-viewer-img');
                    if (viewerImgEl) viewerImgEl.src = base64;
                    const topPhotoInput = document.getElementById('top-edit-photo-val');
                    const topPhotoPreview = document.getElementById('top-edit-photo-preview');
                    const topPhotoPlaceholder = document.getElementById('top-edit-photo-placeholder');
                    const topRemoveBtn = document.getElementById('top-edit-remove-btn');
                    if (topPhotoInput) topPhotoInput.value = base64;
                    if (topPhotoPreview) { topPhotoPreview.src = base64; topPhotoPreview.classList.remove('hidden'); }
                    if (topPhotoPlaceholder) topPhotoPlaceholder.classList.add('hidden');
                    if (topRemoveBtn) topRemoveBtn.classList.remove('hidden');
                    if (studentProfile) {
                        studentProfile.photo = base64;
                        if (studentProfile.profile) studentProfile.profile.photo = base64;
                    }
                } catch (err) {
                    progressCtrl.fail();
                    console.error('Failed to save student photo:', err);
                    alert('Failed to save photo: ' + err.message);
                }
            });
        };

        const startAvatarCircularProgress = () => {
            const ringSvg = document.getElementById('student-photo-progress-ring');
            const circle = document.getElementById('student-photo-progress-circle');
            const overlay = document.getElementById('student-photo-progress-overlay');
            const textEl = document.getElementById('student-photo-progress-text');
            const circumference = 351.86;
            let currentPct = 8;

            const applyPct = (pct, color = '#2563eb') => {
                currentPct = Math.max(0, Math.min(100, Math.round(pct)));
                if (circle) {
                    const offset = circumference - (currentPct / 100) * circumference;
                    circle.style.strokeDashoffset = String(offset);
                    circle.style.stroke = color;
                }
                if (textEl) {
                    textEl.innerHTML = currentPct >= 100 ? `<i class="fas fa-check text-emerald-400 mr-1"></i>100%` : `${currentPct}%`;
                }
            };

            if (ringSvg) ringSvg.classList.remove('hidden');
            if (overlay) {
                overlay.classList.remove('hidden');
                overlay.classList.add('flex');
            }
            applyPct(8);

            const interval = setInterval(() => {
                if (currentPct < 90) {
                    applyPct(currentPct + 4);
                }
            }, 140);

            return {
                setProgress: (val) => {
                    if (val > currentPct) applyPct(val);
                },
                complete: () => new Promise((resolve) => {
                    clearInterval(interval);
                    applyPct(100, '#10b981');
                    setTimeout(() => {
                        if (ringSvg) ringSvg.classList.add('hidden');
                        if (overlay) {
                            overlay.classList.add('hidden');
                            overlay.classList.remove('flex');
                        }
                        applyPct(0);
                        resolve();
                    }, 650);
                }),
                fail: () => {
                    clearInterval(interval);
                    applyPct(100, '#ef4444');
                    setTimeout(() => {
                        if (ringSvg) ringSvg.classList.add('hidden');
                        if (overlay) {
                            overlay.classList.add('hidden');
                            overlay.classList.remove('flex');
                        }
                        applyPct(0);
                    }, 800);
                }
            };
        };

        const stopStudentCamera = () => {
            if (cameraStream) {
                cameraStream.getTracks().forEach(track => track.stop());
                cameraStream = null;
            }
            document.getElementById('student-camera-modal').classList.add('hidden');
            document.getElementById('student-camera-modal').classList.remove('flex');
        };

        const renderStudentComprehensiveProfile = (st, studentPhotoSubmission = null) => {
            const prof = st.profile || {};
            
            // Photo & Avatar
            const userPhoto = st.photo || prof.photo || studentPhotoSubmission?.photo || '';
            const avatarEl = document.getElementById('dash-avatar');
            const viewerModal = document.getElementById('student-photo-viewer-modal');
            const viewerImg = document.getElementById('student-photo-viewer-img');

            if (userPhoto) {
                if (avatarEl) avatarEl.innerHTML = `<img src="${userPhoto}" class="w-full h-full object-cover rounded-full" alt="Profile Photo">`;
                if (viewerImg) viewerImg.src = userPhoto;
            } else {
                const initial = getStudentInitial(st);
                if (avatarEl) {
                    avatarEl.innerHTML = `
                        <div class="w-full h-full rounded-full bg-gradient-to-br from-blue-900 via-indigo-950 to-slate-900 text-white flex items-center justify-center font-black text-4xl sm:text-5xl shadow-inner border-2 border-amber-400">
                            ${escapeHtml(initial)}
                        </div>
                    `;
                }
            }

            // Clicking avatar opens viewer if photo exists
            const openPhotoViewer = () => {
                if (userPhoto && viewerModal && viewerImg) {
                    viewerImg.src = userPhoto;
                    viewerModal.classList.remove('hidden');
                    viewerModal.classList.add('flex');
                }
            };

            if (avatarEl && !avatarEl.dataset.bound) {
                avatarEl.dataset.bound = 'true';
                avatarEl.addEventListener('click', openPhotoViewer);
            }

            const viewerCloseBtn = document.getElementById('student-photo-viewer-close-btn');
            if (viewerCloseBtn && !viewerCloseBtn.dataset.bound) {
                viewerCloseBtn.dataset.bound = 'true';
                viewerCloseBtn.addEventListener('click', () => {
                    viewerModal?.classList.add('hidden');
                    viewerModal?.classList.remove('flex');
                });
            }

            if (viewerModal && !viewerModal.dataset.bound) {
                viewerModal.dataset.bound = 'true';
                viewerModal.addEventListener('click', (e) => {
                    if (e.target === viewerModal) {
                        viewerModal.classList.add('hidden');
                        viewerModal.classList.remove('flex');
                    }
                });
            }

            // Class
            const classVal = st.class || st.studentClass || prof.class || prof.studentClass || '-';
            const isAlumni = String(classVal).trim().toLowerCase() === 'alumni' || st.status === 'alumni' || st.status === 'graduated' || st.isAlumni === true;
            const classEl = document.getElementById('dash-class');
            if (classEl) classEl.textContent = isAlumni ? `Status: 🎓 Alumni` : `Class: ${classVal}`;
            const classValEl = document.getElementById('dash-class-val');
            if (classValEl) classValEl.textContent = isAlumni ? `🎓 Alumni` : classVal;

            // Academic Year (Shown in Profile Header)
            const acadYear = currentAcademicYear || st.academicYear || prof.academicYear || selectedFeeAcademicYear || '';
            const acadYearEl = document.getElementById('dash-academic-year');
            if (acadYearEl) {
                acadYearEl.textContent = acadYear ? `Academic Year: ${acadYear}` : 'Academic Year: Current';
            }

            // ID / UID
            const uidVal = st.uid || prof.uid || st.id || prof.id || '-';
            const uidEl = document.getElementById('dash-uid');
            if (uidEl) uidEl.textContent = uidVal;
            const uidValEl = document.getElementById('dash-uid-val');
            if (uidValEl) uidValEl.textContent = uidVal;

            // Student Name
            const nameVal = st.name || prof.name || '-';
            const nameEl = document.getElementById('dash-name');
            if (nameEl) nameEl.textContent = nameVal;

            // Father's Name
            const fatherVal = st.father || prof.father || '-';
            const fatherEl = document.getElementById('dash-father');
            if (fatherEl) fatherEl.textContent = fatherVal;

            // Mother's Name
            const motherVal = st.mother || prof.mother || '-';
            const motherEl = document.getElementById('dash-mother');
            if (motherEl) motherEl.textContent = motherVal;

            // Gender
            const genderVal = st.gender || prof.gender || '-';
            const genderEl = document.getElementById('dash-gender');
            if (genderEl) genderEl.textContent = genderVal;
            const genderValEl = document.getElementById('dash-gender-val');
            if (genderValEl) genderValEl.textContent = genderVal;
            const genderBadge = document.getElementById('dash-gender-badge');
            if (genderBadge) {
                const isFemale = String(genderVal).toLowerCase().startsWith('f');
                genderBadge.innerHTML = `<i class="fas fa-${isFemale ? 'venus' : 'mars'}"></i> <span id="dash-gender">${escapeHtml(genderVal)}</span>`;
            }

            // Admission Number (Adm. No.)
            const admVal = st.adm || prof.admNo || prof.adm || st.admissionNo || prof.admissionNo || '-';
            const admEl = document.getElementById('dash-adm');
            if (admEl) admEl.textContent = admVal;
            const admValEl = document.getElementById('dash-adm-val');
            if (admValEl) admValEl.textContent = admVal;

            // Date of Birth
            const rawDob = st.dob || prof.dob || '';
            const dobVal = rawDob ? formatDateDisplay(rawDob) : '-';
            const dobEl = document.getElementById('dash-dob');
            if (dobEl) dobEl.textContent = dobVal;

            // Date of Admission
            const rawAdmDate = st.admDate || prof.admDate || '';
            const admDateVal = rawAdmDate ? formatDateDisplay(rawAdmDate) : '-';
            const admDateEl = document.getElementById('dash-adm-date');
            if (admDateEl) admDateEl.textContent = admDateVal;

            // Student Status
            const statusVal = st.status || prof.status || 'Active';
            const statusEl = document.getElementById('dash-status');
            if (statusEl) statusEl.textContent = statusVal;
            const statusValEl = document.getElementById('dash-status-val');
            if (statusValEl) statusValEl.textContent = statusVal;
            const statusBadge = document.getElementById('dash-status-badge');
            if (statusBadge) {
                const isInactive = /inactive|tc|leaving|discontinued|cancelled/i.test(String(statusVal));
                if (isInactive) {
                    statusBadge.className = 'bg-rose-100/80 text-rose-800 text-xs font-bold px-3 py-1 rounded-full border border-rose-200 flex items-center gap-1.5';
                    statusBadge.innerHTML = `<i class="fas fa-times-circle"></i> <span id="dash-status">${escapeHtml(statusVal)}</span>`;
                } else {
                    statusBadge.className = 'bg-emerald-100/80 text-emerald-800 text-xs font-bold px-3 py-1 rounded-full border border-emerald-200 flex items-center gap-1.5';
                    statusBadge.innerHTML = `<i class="fas fa-check-circle"></i> <span id="dash-status">${escapeHtml(statusVal)}</span>`;
                }
            }

            // Aadhaar Number
            const adhaarVal = st.adhaar || prof.adhaar || st.aadhaar || prof.aadhaar || '-';
            const adhaarEl = document.getElementById('dash-adhaar');
            if (adhaarEl) adhaarEl.textContent = adhaarVal;

            // Father's Phone Number
            const mobileVal = st.mobile || prof.mobile || st.phone || prof.phone || '';
            const mobileEl = document.getElementById('dash-mobile');
            if (mobileEl) mobileEl.textContent = mobileVal || '-';
            const mobileLinkEl = document.getElementById('dash-mobile-link');
            if (mobileLinkEl) {
                if (mobileVal) {
                    mobileLinkEl.href = `tel:${mobileVal}`;
                    mobileLinkEl.classList.remove('pointer-events-none');
                } else {
                    mobileLinkEl.removeAttribute('href');
                    mobileLinkEl.classList.add('pointer-events-none');
                }
            }
            const mobileCopyEl = document.getElementById('dash-mobile-copy');
            if (mobileCopyEl) mobileCopyEl.dataset.copyValue = encodeURIComponent(mobileVal);

            // Mother's Phone Number
            const motherMobileVal = st.motherMobile || prof.motherMobile || '';
            const motherMobileEl = document.getElementById('dash-mother-mobile');
            if (motherMobileEl) motherMobileEl.textContent = motherMobileVal || '-';
            const motherMobileLinkEl = document.getElementById('dash-mother-mobile-link');
            if (motherMobileLinkEl) {
                if (motherMobileVal) {
                    motherMobileLinkEl.href = `tel:${motherMobileVal}`;
                    motherMobileLinkEl.classList.remove('pointer-events-none');
                } else {
                    motherMobileLinkEl.removeAttribute('href');
                    motherMobileLinkEl.classList.add('pointer-events-none');
                }
            }
            const motherMobileCopyEl = document.getElementById('dash-mother-mobile-copy');
            if (motherMobileCopyEl) motherMobileCopyEl.dataset.copyValue = encodeURIComponent(motherMobileVal);

            // Permanent Address
            const addrVal = st.address || prof.address || '-';
            const addrEl = document.getElementById('dash-addr');
            if (addrEl) addrEl.textContent = addrVal;

            // Apply portal permissions (show/hide edit buttons)
            applyStudentPortalPermissionsUI();

            // RENDER BOTTOM CONCESSION & SIBLING GROUP SECTION
            renderConcessionAndGroupSection(st);
        };

        const applyStudentPortalPermissionsUI = () => {
            const photoTopEditBtn = document.getElementById('student-edit-top-btn');
            if (photoTopEditBtn) {
                if (studentPortalPerms.allowPhotoUpload) {
                    photoTopEditBtn.classList.remove('hidden');
                } else {
                    photoTopEditBtn.classList.add('hidden');
                }
            }
            const photoControls = document.getElementById('student-photo-controls');
            if (photoControls) {
                if (studentPortalPerms.allowPhotoUpload) {
                    photoControls.classList.remove('hidden');
                    photoControls.classList.add('flex');
                } else {
                    photoControls.classList.add('hidden');
                    photoControls.classList.remove('flex');
                }
            }
            const fieldEditBtns = document.querySelectorAll('.field-edit-btn');
            fieldEditBtns.forEach(btn => {
                if (studentPortalPerms.allowDetailsEdit) {
                    btn.classList.remove('hidden');
                } else {
                    btn.classList.add('hidden');
                }
            });
            const editDetailsBtn = document.getElementById('student-edit-details-btn');
            if (editDetailsBtn) {
                if (studentPortalPerms.allowDetailsEdit) {
                    editDetailsBtn.classList.remove('hidden');
                } else {
                    editDetailsBtn.classList.add('hidden');
                }
            }
        };

        const renderConcessionAndGroupSection = (st) => {
            const sectionEl = document.getElementById('dash-concession-group-section');
            const detailsEl = document.getElementById('dash-concession-group-details');
            const badgeEl = document.getElementById('dash-group-badge');
            if (!detailsEl) return;

            const activeGroup = (studentGroups || []).find((g) => g.memberIds?.includes(studentId));
            const hasConcession = st.concessionFee !== undefined && st.concessionFee !== null && st.concessionFee !== "";

            if (!activeGroup && !hasConcession) {
                if (sectionEl) sectionEl.classList.add('hidden');
                detailsEl.innerHTML = '';
                return;
            }
            if (sectionEl) sectionEl.classList.remove('hidden');

            let html = '';
            let badgeText = 'Standard Fee';
            let badgeClass = 'bg-slate-100 text-slate-600 border-slate-200';

            if (activeGroup) {
                badgeText = 'Sibling Group Active';
                badgeClass = 'bg-indigo-50 text-indigo-700 border-indigo-200';
                
                const groupFee = Number(activeGroup.fee || 0);
                const memberCount = (activeGroup.memberIds || []).length;
                
                const membersHtml = (activeGroup.memberIds || []).map((mId) => {
                    const mProfile = groupMemberProfileMap[mId] || {};
                    const isCurrent = mId === studentId;
                    const mName = mProfile.name || (isCurrent ? (st.name || 'Current Student') : `Sibling (${mId.slice(0, 6)})`);
                    const mClass = mProfile.class || mProfile.studentClass || (isCurrent ? (st.class || '--') : '--');
                    const mAdm = mProfile.adm || mProfile.profile?.admNo || (isCurrent ? (st.adm || '--') : '--');

                    return `
                    <div class="flex items-center justify-between p-2.5 rounded-lg border ${isCurrent ? 'bg-blue-50/80 border-blue-200' : 'bg-white border-slate-200'} text-xs">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <div class="w-7 h-7 rounded-full ${isCurrent ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'} font-bold flex items-center justify-center shrink-0 text-xs">
                                ${escapeHtml(mName.charAt(0).toUpperCase())}
                            </div>
                            <div class="min-w-0 truncate">
                                <div class="font-bold text-slate-800 truncate flex items-center gap-1.5">
                                    ${escapeHtml(mName)}
                                    ${isCurrent ? '<span class="text-[10px] font-extrabold bg-blue-600 text-white px-1.5 py-0.2 rounded-full">You</span>' : ''}
                                </div>
                                <div class="text-[11px] text-slate-500 font-medium">Class: <span class="font-semibold text-slate-700">${escapeHtml(mClass)}</span> | Adm: <span class="font-mono text-slate-700">${escapeHtml(mAdm)}</span></div>
                            </div>
                        </div>
                    </div>`;
                }).join('');

                html += `
                <div class="bg-indigo-50/60 border border-indigo-200 rounded-xl p-4 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-100 pb-2.5">
                        <div>
                            <div class="text-xs font-black uppercase text-indigo-600 tracking-wider">Sibling / Family Group</div>
                            <h5 class="text-base font-extrabold text-indigo-950">${escapeHtml(activeGroup.name || 'Family Sibling Group')}</h5>
                        </div>
                        <div class="text-right">
                            <div class="text-xs text-indigo-600 font-semibold">Special Group Rate</div>
                            <span class="text-sm sm:text-base font-black text-indigo-700 bg-white px-2.5 py-1 rounded-lg border border-indigo-200 shadow-xs inline-block">
                                ₹${groupFee.toLocaleString('en-IN')} <span class="text-xs font-normal text-indigo-500">/ month</span>
                            </span>
                        </div>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-indigo-900 mb-2 flex items-center gap-1.5">
                            <i class="fas fa-users text-xs text-indigo-600"></i> Included Siblings (${memberCount} Members):
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            ${membersHtml}
                        </div>
                    </div>
                </div>`;
            }

            if (hasConcession) {
                badgeText = activeGroup ? 'Group + Concession Active' : 'Fee Concession Active';
                badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                const concFee = Number(st.concessionFee);

                html += `
                <div class="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 space-y-2">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <div class="text-xs font-black uppercase text-emerald-700 tracking-wider">Special Concession Rate</div>
                            <div class="text-sm font-extrabold text-emerald-950">Approved Fee Concession</div>
                        </div>
                        <span class="text-sm sm:text-base font-black text-emerald-800 bg-white px-3 py-1 rounded-lg border border-emerald-200 shadow-xs">
                            ₹${concFee.toLocaleString('en-IN')} <span class="text-xs font-normal text-emerald-600">/ month</span>
                        </span>
                    </div>
                    <p class="text-xs text-emerald-800 leading-relaxed">
                        This student has been granted an institutional fee concession in the admin portal. Monthly dues will be calculated at ₹${concFee.toLocaleString('en-IN')}.
                    </p>
                </div>`;
            }

            detailsEl.innerHTML = html;
            if (badgeEl) {
                badgeEl.textContent = badgeText;
                badgeEl.className = `text-xs font-bold px-2.5 py-0.5 rounded-full border ${badgeClass}`;
            }
        };

        // SETUP PHOTO EDIT MODAL (Pencil icon on photo)
        const setupStudentTopIdentityEdit = (studentId, currentSt) => {
            const topEditBtn = document.getElementById('student-edit-top-btn');
            const topModal = document.getElementById('student-edit-top-modal');
            const closeBtn = document.getElementById('student-edit-top-close-btn');
            const cancelBtn = document.getElementById('student-edit-top-cancel-btn');
            const saveBtn = document.getElementById('student-edit-top-save-btn');
            const cameraBtn = document.getElementById('top-edit-camera-btn');
            const uploadBtn = document.getElementById('top-edit-upload-btn');
            const removeBtn = document.getElementById('top-edit-remove-btn');
            const photoValInput = document.getElementById('top-edit-photo-val');
            const photoPreview = document.getElementById('top-edit-photo-preview');
            const photoPlaceholder = document.getElementById('top-edit-photo-placeholder');

            if (!topEditBtn || !topModal || topEditBtn.dataset.bound === 'true') return;
            topEditBtn.dataset.bound = 'true';

            const closeModal = () => {
                topModal.classList.add('hidden');
                topModal.classList.remove('flex');
            };

            const updateModalPhotoPreview = (photoUrl) => {
                if (photoValInput) photoValInput.value = photoUrl || '';
                if (photoUrl) {
                    if (photoPreview) { photoPreview.src = photoUrl; photoPreview.classList.remove('hidden'); }
                    if (photoPlaceholder) photoPlaceholder.classList.add('hidden');
                    if (removeBtn) removeBtn.classList.remove('hidden');
                } else {
                    if (photoPreview) { photoPreview.src = ''; photoPreview.classList.add('hidden'); }
                    if (photoPlaceholder) photoPlaceholder.classList.remove('hidden');
                    if (removeBtn) removeBtn.classList.add('hidden');
                }
            };

            topEditBtn.addEventListener('click', () => {
                if (!studentPortalPerms.allowPhotoUpload) {
                    alert('Photo upload is currently disabled by administrator.');
                    return;
                }
                const prof = currentSt.profile || {};
                updateModalPhotoPreview(currentSt.photo || prof.photo || '');

                topModal.classList.remove('hidden');
                topModal.classList.add('flex');
            });

            closeBtn?.addEventListener('click', closeModal);
            cancelBtn?.addEventListener('click', closeModal);

            uploadBtn?.addEventListener('click', () => {
                document.getElementById('student-photo-file-input')?.click();
            });

            cameraBtn?.addEventListener('click', async () => {
                closeModal();
                const cameraModal = document.getElementById('student-camera-modal');
                if (cameraModal) {
                    cameraModal.classList.remove('hidden');
                    cameraModal.classList.add('flex');
                    const ok = await startStudentCamera('user');
                    if (!ok) {
                        stopStudentCamera();
                    }
                }
            });

            removeBtn?.addEventListener('click', () => {
                updateModalPhotoPreview('');
            });

            saveBtn?.addEventListener('click', async () => {
                const newPhoto = photoValInput?.value || '';

                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';
                closeModal();
                const progressCtrl = startAvatarCircularProgress();

                try {
                    progressCtrl.setProgress(35);
                    const studentRef = doc(db, `${BASE_PATH}/students`, studentId);
                    const currentProf = currentSt.profile || {};
                    const updatedProf = {
                        ...currentProf,
                        photo: newPhoto
                    };

                    await setDoc(studentRef, {
                        photo: newPhoto,
                        profile: updatedProf
                    }, { merge: true });

                    progressCtrl.setProgress(80);
                    await setDoc(doc(db, `${BASE_PATH}/studentPhotoSubmissions`, studentId), {
                        photo: newPhoto,
                        updatedAt: Date.now()
                    }, { merge: true });

                    currentSt.photo = newPhoto;
                    currentSt.profile = updatedProf;

                    await progressCtrl.complete();
                    renderStudentComprehensiveProfile(currentSt);
                } catch (err) {
                    progressCtrl.fail();
                    console.error('Failed to update photo:', err);
                    alert('Failed to update photo: ' + err.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Photo';
                }
            });
        };

        // SETUP QUICK EDIT FOR INDIVIDUAL PERMITTED FIELDS
        const setupStudentQuickFieldEdit = (studentId, currentSt) => {
            const modal = document.getElementById('student-quick-edit-modal');
            const closeBtn = document.getElementById('student-quick-edit-close-btn');
            const cancelBtn = document.getElementById('student-quick-edit-cancel-btn');
            const saveBtn = document.getElementById('student-quick-edit-save-btn');
            const titleEl = document.getElementById('quick-edit-title');
            const labelEl = document.getElementById('quick-edit-label');
            const inputContainer = document.getElementById('quick-edit-input-container');

            if (!modal) return;

            let activeField = '';
            let activeLabel = '';

            const ALLOWED_STUDENT_EDIT_FIELDS = ['name', 'father', 'mother', 'gender', 'dob', 'adhaar', 'mobile', 'motherMobile', 'address'];

            const closeModal = () => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            };

            closeBtn?.addEventListener('click', closeModal);
            cancelBtn?.addEventListener('click', closeModal);

            document.querySelectorAll('.field-edit-btn').forEach((btn) => {
                if (btn.dataset.bound === 'true') return;
                btn.dataset.bound = 'true';

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const field = btn.dataset.field;
                    const label = btn.dataset.label;
                    const type = btn.dataset.type || 'text';
                    const options = btn.dataset.options || '';

                    if (!studentPortalPerms.allowDetailsEdit) {
                        alert('Details editing is currently disabled by administrator.');
                        return;
                    }

                    if (!ALLOWED_STUDENT_EDIT_FIELDS.includes(field)) {
                        alert('This field cannot be edited by students.');
                        return;
                    }

                    activeField = field;
                    activeLabel = label;

                    const prof = currentSt.profile || {};
                    let curVal = '';
                    if (field === 'name') curVal = currentSt.name || prof.name || '';
                    else if (field === 'dob') curVal = currentSt.dob || prof.dob || '';
                    else if (field === 'gender') curVal = currentSt.gender || prof.gender || 'Male';
                    else if (field === 'adhaar') curVal = currentSt.adhaar || prof.adhaar || currentSt.aadhaar || prof.aadhaar || '';
                    else if (field === 'father') curVal = currentSt.father || prof.father || '';
                    else if (field === 'mobile') curVal = currentSt.mobile || prof.mobile || currentSt.phone || prof.phone || '';
                    else if (field === 'mother') curVal = currentSt.mother || prof.mother || '';
                    else if (field === 'motherMobile') curVal = currentSt.motherMobile || prof.motherMobile || '';
                    else if (field === 'address') curVal = currentSt.address || prof.address || '';

                    if (titleEl) titleEl.innerHTML = `<i class="fas fa-pencil-alt text-blue-600"></i> Edit ${escapeHtml(label)}`;
                    if (labelEl) labelEl.textContent = label;

                    if (type === 'select') {
                        const optList = options.split(',').map((o) => o.trim());
                        inputContainer.innerHTML = `
                            <select id="quick-edit-input" class="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none">
                                ${optList.map((opt) => `<option value="${escapeHtml(opt)}" ${opt.toLowerCase() === String(curVal).toLowerCase() ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
                            </select>`;
                    } else if (type === 'textarea') {
                        inputContainer.innerHTML = `
                            <textarea id="quick-edit-input" rows="3" class="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none">${escapeHtml(curVal)}</textarea>`;
                    } else if (field === 'name') {
                        inputContainer.innerHTML = `
                            <input type="text" id="quick-edit-input" value="${escapeHtml(curVal)}" class="w-full p-2.5 border rounded-lg text-sm uppercase font-semibold bg-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="Student Name">`;
                    } else {
                        inputContainer.innerHTML = `
                            <input type="${type}" id="quick-edit-input" value="${escapeHtml(curVal)}" class="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none">`;
                    }

                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    document.getElementById('quick-edit-input')?.focus();
                });
            });

            saveBtn?.addEventListener('click', async () => {
                const inputEl = document.getElementById('quick-edit-input');
                if (!inputEl) return;
                let newVal = inputEl.value.trim();

                if (activeField === 'name') {
                    newVal = newVal.toUpperCase();
                    if (!newVal) {
                        alert('Student name is required!');
                        return;
                    }
                }

                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';

                try {
                    const studentRef = doc(db, `${BASE_PATH}/students`, studentId);
                    const currentProf = currentSt.profile || {};
                    const updatedProf = { ...currentProf, [activeField]: newVal };
                    const updateData = { [activeField]: newVal, profile: updatedProf };

                    if (activeField === 'name') {
                        updateData.name = newVal;
                        updatedProf.name = newVal;
                    }
                    if (activeField === 'adhaar') {
                        updateData.aadhaar = newVal;
                        updatedProf.adhaar = newVal;
                        updatedProf.aadhaar = newVal;
                    }
                    if (activeField === 'mobile') {
                        updateData.phone = newVal;
                        updatedProf.mobile = newVal;
                        updatedProf.phone = newVal;
                    }

                    await setDoc(studentRef, updateData, { merge: true });

                    currentSt[activeField] = newVal;
                    currentSt.profile = updatedProf;
                    if (activeField === 'name') currentSt.name = newVal;
                    if (activeField === 'adhaar') currentSt.aadhaar = newVal;
                    if (activeField === 'mobile') currentSt.phone = newVal;

                    renderStudentComprehensiveProfile(currentSt);
                    closeModal();
                    alert(`${activeLabel} updated successfully!`);
                } catch (err) {
                    console.error(`Failed to update ${activeField}:`, err);
                    alert(`Failed to save: ` + err.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
            });
        };

        const setupStudentEditDetailsActions = (studentId, currentSt) => {
            const editBtn = document.getElementById('student-edit-details-btn');
            const modal = document.getElementById('student-edit-details-modal');
            const closeBtn = document.getElementById('student-edit-details-close-btn');
            const cancelBtn = document.getElementById('student-edit-details-cancel-btn');
            const saveBtn = document.getElementById('student-edit-details-save-btn');

            if (!editBtn || !modal || editBtn.dataset.bound === 'true') return;
            editBtn.dataset.bound = 'true';

            const closeModal = () => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            };

            editBtn.addEventListener('click', () => {
                const prof = currentSt.profile || {};
                const nameInput = document.getElementById('st-edit-name');
                const genderInput = document.getElementById('st-edit-gender');
                const dobInput = document.getElementById('st-edit-dob');
                const adhaarInput = document.getElementById('st-edit-adhaar');
                const fatherInput = document.getElementById('st-edit-father');
                const motherInput = document.getElementById('st-edit-mother');
                const fatherPhoneInput = document.getElementById('st-edit-father-phone');
                const motherPhoneInput = document.getElementById('st-edit-mother-phone');
                const addressInput = document.getElementById('st-edit-address');

                if (nameInput) nameInput.value = currentSt.name || prof.name || '';
                if (genderInput) genderInput.value = currentSt.gender || prof.gender || 'Male';
                if (dobInput) dobInput.value = currentSt.dob || prof.dob || '';
                if (adhaarInput) adhaarInput.value = currentSt.adhaar || prof.adhaar || currentSt.aadhaar || prof.aadhaar || '';
                if (fatherInput) fatherInput.value = currentSt.father || prof.father || '';
                if (motherInput) motherInput.value = currentSt.mother || prof.mother || '';
                if (fatherPhoneInput) fatherPhoneInput.value = currentSt.mobile || prof.mobile || currentSt.phone || prof.phone || '';
                if (motherPhoneInput) motherPhoneInput.value = currentSt.motherMobile || prof.motherMobile || '';
                if (addressInput) addressInput.value = currentSt.address || prof.address || '';

                modal.classList.remove('hidden');
                modal.classList.add('flex');
            });

            closeBtn?.addEventListener('click', closeModal);
            cancelBtn?.addEventListener('click', closeModal);

            saveBtn?.addEventListener('click', async () => {
                const newName = document.getElementById('st-edit-name')?.value.trim();
                const newGender = document.getElementById('st-edit-gender')?.value || 'Male';
                const newDob = document.getElementById('st-edit-dob')?.value || '';
                const newAdhaar = document.getElementById('st-edit-adhaar')?.value.trim() || '';
                const newFather = document.getElementById('st-edit-father')?.value.trim();
                const newMother = document.getElementById('st-edit-mother')?.value.trim();
                const newFatherPhone = document.getElementById('st-edit-father-phone')?.value.trim();
                const newMotherPhone = document.getElementById('st-edit-mother-phone')?.value.trim();
                const newAddress = document.getElementById('st-edit-address')?.value.trim();

                if (!newName) {
                    alert('Student name is required!');
                    return;
                }

                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';

                try {
                    const studentRef = doc(db, `${BASE_PATH}/students`, studentId);
                    const currentProfile = currentSt.profile || {};
                    const updatedProfile = {
                        ...currentProfile,
                        name: newName,
                        gender: newGender,
                        dob: newDob,
                        adhaar: newAdhaar,
                        father: newFather,
                        mother: newMother,
                        mobile: newFatherPhone,
                        motherMobile: newMotherPhone,
                        address: newAddress
                    };

                    await setDoc(studentRef, {
                        name: newName,
                        gender: newGender,
                        dob: newDob,
                        adhaar: newAdhaar,
                        father: newFather,
                        mother: newMother,
                        mobile: newFatherPhone,
                        motherMobile: newMotherPhone,
                        address: newAddress,
                        profile: updatedProfile
                    }, { merge: true });

                    currentSt.name = newName;
                    currentSt.gender = newGender;
                    currentSt.dob = newDob;
                    currentSt.adhaar = newAdhaar;
                    currentSt.father = newFather;
                    currentSt.mother = newMother;
                    currentSt.mobile = newFatherPhone;
                    currentSt.motherMobile = newMotherPhone;
                    currentSt.address = newAddress;
                    currentSt.profile = updatedProfile;

                    renderStudentComprehensiveProfile(currentSt);
                    closeModal();
                    alert('Student details updated successfully!');
                } catch (err) {
                    console.error('Failed to update student profile:', err);
                    alert('Failed to update: ' + err.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Changes';
                }
            });
        };

        const saveStudentPhotoSubmission = async () => {};

        const renderStudentFeeDetails = (st, targetYear = '') => {
            const activeYear = targetYear || st?.academicYear || '--';
            const classLabel = resolveAcademicClass(activeYear, st);
            document.getElementById('fee-class-label').textContent = `Class: ${classLabel}`;
            renderAcademicYearSelect('fee-year-select', activeYear);

            let baseFee = defaultFee;
            const hasConcession = st.concessionFee !== undefined && st.concessionFee !== null && st.concessionFee !== "";
            const activeGroup = (studentGroups || []).find(g => Array.isArray(g.memberIds) && g.memberIds.includes(studentId));
            const concGroup = document.getElementById('dash-conc-group');
            concGroup?.classList.add('hidden');
            if(hasConcession) {
                baseFee = parseFloat(st.concessionFee);
            } else if(activeGroup && activeGroup.fee > 0) {
                baseFee = activeGroup.fee;
            }

            const currentYearFeeItems = feeItems.filter((item) => (item.academicYear || st.academicYear || '') === activeYear);
            const yearPayments = allPayments.filter((payment) => {
                const item = currentYearFeeItems.find((feeItem) => feeItem.key === payment.itemKey);
                const paymentYear = payment.academicYear || item?.academicYear || '';
                return paymentYear === activeYear;
            });
            const paymentsByItem = new Map(yearPayments.map((payment) => [payment.itemKey, payment]));
            const studentDonationPayments = yearPayments.filter((payment) => payment.itemKey === STUDENT_DONATION_ITEM_KEY);

            const visibleItems = currentYearFeeItems.filter(i => {
                if(i.isVisible === false) return false;
                if(i.type === 'custom' && i.scope === 'specific' && i.targetClass !== classLabel) return false;
                return true;
            });
            if (yearPayments.some((payment) => payment.itemKey === STUDENT_DONATION_ITEM_KEY) && !visibleItems.some((item) => item.key === STUDENT_DONATION_ITEM_KEY)) {
                visibleItems.push({ key: STUDENT_DONATION_ITEM_KEY, name: 'Donation', type: 'custom', scope: 'global' });
            }

            let totalPaidAmount = 0;
            let totalDueAmount = 0;
            let paidItemsCount = 0;
            let dueItemsCount = 0;
            let lastPaymentDate = '';
            const paidInsightItems = [];
            const pendingInsightItems = [];
            const paymentHistoryItems = [];

            const generateFeeCardHtml = (item) => {
                const pay = paymentsByItem.get(item.key);
                const isSpecialOptional = item.key === STUDENT_DONATION_ITEM_KEY;
                const latestDonationPayment = studentDonationPayments
                    .slice()
                    .sort((a, b) => String(b.paymentDate || '').localeCompare(String(a.paymentDate || '')))[0];
                const donationSummary = isSpecialOptional
                    ? {
                        amount: studentDonationPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
                        paymentDate: latestDonationPayment?.paymentDate || '',
                        receiptNo: studentDonationPayments.length ? `${studentDonationPayments.length} entries` : '',
                        collectedByName: latestDonationPayment?.collectedByName || latestDonationPayment?.collectedBy || 'Admin'
                    }
                    : null;

                const isMonthlyDefault = !item.type || item.type === 'month';
                const cardName = isMonthlyDefault ? formatMonthFeeCardName(item.name) : (item.name || 'Fee Item');

                if (pay || donationSummary) {
                    paidItemsCount += 1;
                    let paidAmount = 0;
                    const isGroupPayment = Boolean(pay && pay.billingGroupId);

                    if (donationSummary) {
                        paidAmount = Number(donationSummary.amount || 0);
                    } else if (pay) {
                        if (pay.groupMonthAmount !== undefined && pay.groupMonthAmount !== null && Number(pay.groupMonthAmount) > 0) {
                            // Exact total amount input in collection page
                            paidAmount = Number(pay.groupMonthAmount);
                        } else if (isGroupPayment) {
                            const memberCount = Math.max(1, Number(activeGroup?.memberIds?.length || 0));
                            paidAmount = (Number(activeGroup?.fee || 0) > 0)
                                ? Number(activeGroup.fee)
                                : (Number(pay.amount || 0) * memberCount);
                        } else {
                            // Individual/single student or custom fee
                            paidAmount = Number(pay.amount || 0);
                        }
                    }

                    totalPaidAmount += paidAmount;
                    const paymentDate = donationSummary ? donationSummary.paymentDate : pay.paymentDate;
                    const dateStr = formatDateDisplay(paymentDate);
                    if (paymentDate && (!lastPaymentDate || paymentDate > lastPaymentDate)) {
                        lastPaymentDate = paymentDate;
                    }
                    const staffName = donationSummary ? donationSummary.collectedByName : (pay.collectedByName || pay.collectedBy || 'Admin');
                    const receiptNo = donationSummary ? donationSummary.receiptNo : (pay.receiptNo ? String(pay.receiptNo) : 'N/A');
                    const paymentDescription = donationSummary ? '' : String(pay.description || '').trim();
                    const paymentDescriptionHtml = paymentDescription
                        ? `<div class="mb-3 border-b border-gray-100 pb-3"><div class="text-xs text-gray-500 font-bold uppercase tracking-wide mb-1">Description</div><div class="text-sm font-semibold text-gray-800 whitespace-pre-wrap break-words">${escapeHtml(paymentDescription)}</div></div>`
                        : '';

                    let statusHints = '';
                    if (isMonthlyDefault) {
                        if (isGroupPayment) {
                            statusHints = ['Group', hasConcession ? 'Concession' : ''].filter(Boolean).join(' • ');
                        } else if (hasConcession) {
                            statusHints = 'Concession';
                        } else if (activeGroup) {
                            statusHints = 'Individual';
                        }
                    }

                    let groupMembersHtml = '';
                    if (isMonthlyDefault && isGroupPayment && activeGroup) {
                        groupMembersHtml = `<div class="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
                            <div class="font-bold uppercase text-[10px] tracking-wide text-slate-500 mb-1">Group Payment Members</div>
                            ${(activeGroup.memberIds || []).map((memberId) => {
                                const member = groupMemberProfileMap[memberId];
                                const memberName = member?.name || memberId;
                                const memberClass = member?.class || classLabel;
                                const isCurrentStudent = memberId === studentId;
                                return `<div class="${isCurrentStudent ? 'font-extrabold text-slate-950' : ''}">${escapeHtml(memberName)} <span class="text-[10px] ${isCurrentStudent ? 'text-slate-700' : 'text-slate-500'}">(${escapeHtml(memberClass)})</span></div>`;
                            }).join('')}
                        </div>`;
                    } else if (isMonthlyDefault && !isGroupPayment && activeGroup) {
                        groupMembersHtml = `<div class="mb-3 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] text-blue-800">
                            <div class="font-bold uppercase text-[10px] tracking-wide text-blue-600 mb-0.5">Individual Payment</div>
                            <div>Paid specifically for <b>${escapeHtml(st.name || 'this student')}</b>. Sibling group rate was not applied.</div>
                        </div>`;
                    }

                    const studentShareHtml = (isGroupPayment && pay && pay.amount && Number(pay.amount) !== paidAmount)
                        ? `<div class="flex justify-between items-center mb-3 border-b border-gray-100 pb-2"><span class="text-xs text-gray-500 font-bold uppercase tracking-wide">Student Share</span><span class="text-sm font-bold text-gray-700">${formatCurrency(pay.amount)}</span></div>`
                        : '';

                    const paidInsight = {
                        status: 'paid',
                        academicYear: activeYear,
                        name: item.name || 'Fee Item',
                        amount: paidAmount,
                        paymentDate,
                        meta: `Paid on <b>${escapeHtml(dateStr)}</b> · Receipt: <b>${escapeHtml(receiptNo)}</b>`
                    };
                    paidInsightItems.push(paidInsight);
                    paymentHistoryItems.push({ ...paidInsight, meta: `Paid date: <b>${escapeHtml(dateStr)}</b> · Fee item: <b>${escapeHtml(item.name || 'Fee Item')}</b> · Collected by: <b>${escapeHtml(staffName)}</b>` });

                    return `
                        <div class="fee-card paid" onclick="openFeeDetailModal(this)" role="button" tabindex="0">
                            <div class="fee-status-badge">PAID</div>
                            <div class="fee-month">${escapeHtml(cardName)}</div>
                            <div class="fee-amt">${formatCurrency(paidAmount)}</div>
                            ${statusHints ? `<div class="fee-card-hint">${escapeHtml(statusHints)}</div>` : ''}
                            <div class="fee-details-panel hidden">
                                <div class="fee-modal-priority-row"><span>Academic Year</span><b>${escapeHtml(activeYear)}</b></div>
                                <div class="fee-modal-priority-row"><span>Fee Item</span><b>${escapeHtml(normalizeFeeItemDisplayName(item.name || 'Fee Item'))}</b></div>
                                ${groupMembersHtml}
                                <div class="fee-modal-priority-row amount paid"><span>Amount</span><b>${formatCurrency(paidAmount)}</b></div>
                                ${studentShareHtml}
                                <div class="flex justify-between items-center mb-3 border-b border-gray-100 pb-2"><span class="text-xs text-gray-500 font-bold uppercase tracking-wide">Receipt No</span><span class="text-sm font-bold font-mono bg-green-50 text-green-700 px-3 py-1 rounded border border-green-200">${escapeHtml(receiptNo)}</span></div>
                                <div class="flex justify-between items-center mb-3 border-b border-gray-100 pb-2"><span class="text-xs text-gray-500 font-bold uppercase tracking-wide">Date Paid</span><span class="text-sm font-bold text-gray-800">${escapeHtml(dateStr)}</span></div>
                                <div class="flex justify-between items-center mb-3 border-b border-gray-100 pb-2"><span class="text-xs text-gray-500 font-bold uppercase tracking-wide">Class</span><span class="text-sm font-bold text-gray-700">${escapeHtml((pay && pay.classLabel) || classLabel)}</span></div>
                                ${paymentDescriptionHtml}
                                <div class="flex justify-between items-center pt-1"><span class="text-xs text-gray-500 font-bold uppercase tracking-wide flex-shrink-0 mr-4">Collected By</span><span class="text-xs font-bold text-blue-600 text-right w-full whitespace-normal" style="word-break: break-word;">${escapeHtml(staffName)}</span></div>
                            </div>
                        </div>`;
                }

                // UNPAID CARD
                if (isSpecialOptional) return '';
                dueItemsCount += 1;

                let amountToPay = defaultFee;
                let statusHints = '';
                let groupMembersHtml = '';

                if (item.type === 'custom') {
                    if (item.scope === 'global') amountToPay = item.amount || 0;
                    else if (item.scope === 'class-wise' && item.classValues) amountToPay = item.classValues[classLabel] || 0;
                    else if (item.scope === 'specific') amountToPay = item.amount || 0;
                } else {
                    const isSiblingPaidForThisMonth = siblingPayments.some((sp) => sp.itemKey === item.key);
                    if (hasConcession) {
                        amountToPay = parseFloat(st.concessionFee);
                        statusHints = 'Concession';
                    } else if (isSiblingPaidForThisMonth) {
                        amountToPay = defaultFee;
                        statusHints = activeGroup ? 'Individual' : '';
                        groupMembersHtml = `<div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                            <div class="font-bold uppercase text-[10px] tracking-wide text-amber-700 mb-0.5">Sibling Settled</div>
                            <div>A sibling has already paid for this month. Individual rate of ${formatCurrency(defaultFee)} applies.</div>
                        </div>`;
                    } else if (activeGroup && Number(activeGroup.fee || 0) > 0) {
                        amountToPay = Number(activeGroup.fee);
                        statusHints = 'Group';
                        groupMembersHtml = `<div class="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
                            <div class="font-bold uppercase text-[10px] tracking-wide text-slate-500 mb-1">Group Members</div>
                            ${(activeGroup.memberIds || []).map((memberId) => {
                                const member = groupMemberProfileMap[memberId];
                                const memberName = member?.name || memberId;
                                const memberClass = member?.class || classLabel;
                                const isCurrentStudent = memberId === studentId;
                                return `<div class="${isCurrentStudent ? 'font-extrabold text-slate-950' : ''}">${escapeHtml(memberName)} <span class="text-[10px] ${isCurrentStudent ? 'text-slate-700' : 'text-slate-500'}">(${escapeHtml(memberClass)})</span></div>`;
                            }).join('')}
                        </div>`;
                    } else {
                        amountToPay = defaultFee;
                    }
                }

                totalDueAmount += parseFloat(amountToPay) || 0;
                pendingInsightItems.push({
                    status: 'pending',
                    academicYear: activeYear,
                    name: item.name || 'Fee Item',
                    amount: amountToPay,
                    meta: `Class: <b>${escapeHtml(classLabel)}</b>`
                });

                const paymentContext = getCollectorPaymentContext(classLabel);
                const duePaymentDetails = paymentContext.details || {};
                const accountLines = renderPaymentDetailRows(duePaymentDetails, { copyable: true });

                return `
                    <div class="fee-card unpaid" onclick="openFeeDetailModal(this)" role="button" tabindex="0">
                        <div class="fee-status-badge">NOT PAID</div>
                        <div class="fee-month">${escapeHtml(cardName)}</div>
                        <div class="fee-amt">${formatCurrency(amountToPay)}</div>
                        ${statusHints ? `<div class="fee-card-hint">${escapeHtml(statusHints)}</div>` : ''}
                        <div class="fee-details-panel hidden">
                            <div class="fee-modal-priority-row"><span>Academic Year</span><b>${escapeHtml(activeYear)}</b></div>
                            <div class="fee-modal-priority-row"><span>Fee Item</span><b>${escapeHtml(normalizeFeeItemDisplayName(item.name || 'Fee Item'))}</b></div>
                            ${groupMembersHtml}
                            <div class="fee-modal-priority-row amount pending"><span>Amount</span><b>${formatCurrency(amountToPay)}</b></div>
                            <div class="text-xs text-gray-500 font-bold uppercase tracking-wide mb-3">Class: ${escapeHtml(classLabel)}</div>
                            <div class="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg p-2 mb-3 font-semibold">Payment Account Owner: ${escapeHtml(paymentContext.ownerLabel)}</div>
                            ${accountLines ? `<div class="text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2 mb-3 space-y-1">${accountLines}</div>` : `<div class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">Payment details are not configured. Please contact office.</div>`}
                        </div>
                    </div>`;
            };

            const monthlyItems = sortMonthlyItemsByAcademicYear(
                visibleItems.filter(i => !i.type || i.type === 'month'),
                activeYear
            );
            const donationItems = visibleItems.filter((item) => item.key === STUDENT_DONATION_ITEM_KEY);
            const otherItems = visibleItems.filter(i => i.type === 'custom' && i.key !== STUDENT_DONATION_ITEM_KEY);
            let sectionsHtml = '';
            if(monthlyItems.length > 0) {
                sectionsHtml += `<h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest mt-2 mb-3 border-b border-gray-200 pb-1">Monthly Fees</h3>`;
                sectionsHtml += `<div class="fee-grid">` + monthlyItems.map(generateFeeCardHtml).join('') + `</div>`;
            }
            if(otherItems.length > 0) {
                sectionsHtml += `<h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest mt-6 mb-3 border-b border-gray-200 pb-1">Other Fees</h3>`;
                sectionsHtml += `<div class="fee-grid">` + otherItems.map(generateFeeCardHtml).join('') + `</div>`;
            }
            if(donationItems.length > 0) {
                sectionsHtml += `<h3 class="text-xs font-bold text-emerald-600 uppercase tracking-widest mt-6 mb-3 border-b border-emerald-100 pb-1">Donation</h3>`;
                sectionsHtml += `<div class="fee-grid">` + donationItems.map(generateFeeCardHtml).join('') + `</div>`;
            }
            document.getElementById('fee-sections-container').innerHTML = sectionsHtml || buildEmptyState('No visible fee items are configured for this academic year.', 'fa-receipt');

            document.getElementById('fee-summary').innerHTML = `
                <div class="mt-6 border-t border-gray-200 pt-5"><div class="grid grid-cols-2 gap-4">
                    <div class="bg-green-50 border border-green-200 p-4 rounded-xl flex flex-col justify-center items-center shadow-sm"><span class="text-[11px] text-green-700 font-bold uppercase tracking-widest mb-1 text-center">Total Paid</span><span class="text-xl font-bold font-mono text-green-700">${formatCurrency(totalPaidAmount)}</span></div>
                    <div class="bg-red-50 border border-red-200 p-4 rounded-xl flex flex-col justify-center items-center shadow-sm"><span class="text-[11px] text-red-700 font-bold uppercase tracking-widest mb-1 text-center">Total Due</span><span class="text-xl font-bold font-mono text-red-700">${formatCurrency(totalDueAmount)}</span></div>
                </div></div>
            `;
            const progressPct = (paidItemsCount + dueItemsCount ? Math.round((paidItemsCount / (paidItemsCount + dueItemsCount)) * 100) : 0);
            latestFeeInsightState.paid = paidInsightItems;
            latestFeeInsightState.pending = pendingInsightItems;
            latestFeeInsightState.payments = paymentHistoryItems
                .slice()
                .sort((a, b) => String(b.paymentDate || '').localeCompare(String(a.paymentDate || '')));
            document.getElementById('fee-status-insights').innerHTML = `
                <div class="insight-grid">
                    <div class="insight-card success cursor-pointer" onclick="openFeeInsightModal('paid')"><div class="insight-label">Paid Items</div><div class="insight-value">${paidItemsCount}</div><div class="insight-subvalue">Completed fee entries</div></div>
                    <div class="insight-card danger cursor-pointer" onclick="openFeeInsightModal('pending')"><div class="insight-label">Pending Items</div><div class="insight-value">${dueItemsCount}</div><div class="insight-subvalue">Items still unpaid</div></div>
                    <div class="insight-card info"><div class="insight-label">Payment Progress</div><div class="insight-value">${progressPct}%</div><div class="insight-subvalue">${paidItemsCount} of ${paidItemsCount + dueItemsCount} items settled</div><div class="fee-progress-track mt-3"><div class="fee-progress-fill" style="width: ${progressPct}%"></div></div></div>
                    <div class="insight-card warning cursor-pointer" onclick="openFeeInsightModal('last')"><div class="insight-label">Last Payment</div><div class="insight-value">${lastPaymentDate ? formatDateDisplay(lastPaymentDate) : '--'}</div><div class="insight-subvalue">${lastPaymentDate ? 'Tap to view date-wise list' : 'No payment recorded yet'}</div></div>
                </div>
            `;

            rawFeeAlerts = buildFeeNotificationAlerts(st);
            rawResultAlerts = buildResultNotificationAlerts(st, studentResultsCache);
            if (window.triggerNotificationUpdate) window.triggerNotificationUpdate();
        };

        async function loadDashboardData() {
            try {
                // Notif Listeners
                onSnapshot(doc(db, `${BASE_PATH}/settings`, 'content'), snap => {
                    rawNotices = snap.exists() && Array.isArray(snap.data().notices) ? snap.data().notices : [];
                    if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                }, (err) => console.warn('Content listener warning:', err));

                onSnapshot(collection(db, `${BASE_PATH}/systemNotifications`), snap => {
                    rawSysNotifs = snap.docs.map(d => ({id: d.id, ...d.data()}));
                    if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                }, (err) => console.warn('System notifications listener warning:', err));

                onSnapshot(doc(db, `${BASE_PATH}/studentNotificationState`, studentId), snap => {
                    if(snap.exists()) {
                        const data = snap.data();
                        notifState.lastMarkedAllReadAt = data.lastMarkedAllReadAt || 0;
                        notifState.readIds = data.readIds || [];
                        notifState.feeDismissedDates = (data.feeDismissedDates && typeof data.feeDismissedDates === 'object') ? data.feeDismissedDates : {};
                    }
                    notifStateLoaded = true;
                    if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                }, (err) => {
                    notifStateLoaded = true;
                    console.warn('Notification state listener warning:', err);
                });

                onSnapshot(doc(db, `${BASE_PATH}/settings`, 'config'), snap => {
                    const conf = snap.exists() ? snap.data() : {};
                    
                    studentPortalPerms.allowPhotoUpload = conf.allowStudentPhotoUpload === true;
                    studentPortalPerms.allowDetailsEdit = conf.allowStudentDetailsEdit === true;
                    applyStudentPortalPermissionsUI();

                    applyInstitutionBranding(conf, {
                        defaultAppName: 'Student Dashboard',
                        primaryTitleIds: ['id-school-name'],
                        subtitleIds: ['id-school-sub'],
                        logoIds: ['header-logo', 'splash-logo-img'],
                        updateDocumentTitle: true,
                        documentTitleSuffix: 'Student Dashboard'
                    });
                    setTimeout(() => { fitText('header-title'); }, 50);
                    renderVersionInfo();
                    defaultFee = conf.defaultFee || 200;
                    feeCollectionConfig = {
                        startDay: Math.min(31, Math.max(1, parseInt(conf.feeCollectionStartDay, 10) || 1)),
                        endDay: Math.min(31, Math.max(1, parseInt(conf.feeCollectionEndDay, 10) || 10)),
                        notifyMode: conf.feeNotifyMode || 'month_start',
                        notifyDaysBefore: Math.min(28, Math.max(1, parseInt(conf.feeNotifyDaysBefore, 10) || 5))
                    };
                    feeItems = conf.feeItems || [];
                    paymentDetails = {
                        accountName: conf.paymentAccountName || conf.paymentUpiName || '',
                        upiNumber: conf.paymentUpiNumber || '',
                        upiId: conf.paymentUpiId || '',
                        bankName: conf.paymentBankName || '',
                        accountNumber: conf.paymentAccountNumber || '',
                        ifsc: conf.paymentIfsc || '',
                        branch: conf.paymentBranch || ''
                    };
                    renderProfilePaymentDetails();
                    if (studentProfile) {
                        availableAcademicYears = buildAvailableAcademicYears(studentProfile, allPayments, studentResultsCache);
                        if (!selectedFeeAcademicYear || !availableAcademicYears.includes(selectedFeeAcademicYear)) selectedFeeAcademicYear = currentAcademicYear && availableAcademicYears.includes(currentAcademicYear) ? currentAcademicYear : availableAcademicYears[0];
                        if (!selectedResultAcademicYear || !availableAcademicYears.includes(selectedResultAcademicYear)) selectedResultAcademicYear = selectedFeeAcademicYear;
                        renderStudentFeeDetails(studentProfile, selectedFeeAcademicYear);
                        renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                    }
                });

                onSnapshot(doc(db, `${BASE_PATH}/settings`, 'sessionControl'), (sessionSnap) => {
                    const sessionData = sessionSnap.exists() ? sessionSnap.data() : {};
                    const startedAt = window.AppSession?.getStartedAt?.() || 0;
                    const forcedAt = sessionData?.lastForcedLogoutAt ? new Date(sessionData.lastForcedLogoutAt).getTime() : 0;
                    if (forcedAt && startedAt && forcedAt > startedAt) {
                        alert(sessionData.message || 'An administrator ended this session. Please sign in again.');
                        logoutStudent();
                    }
                });
                onSnapshot(doc(db, `${BASE_PATH}/settings`, 'academicYears'), (academicYearSnap) => {
                    const academicData = academicYearSnap.exists() ? academicYearSnap.data() : {};
                    academicYearSettings = Array.isArray(academicData.years) ? academicData.years : [];
                    currentAcademicYear = academicData.currentYear || currentAcademicYear || '';
                    const acadYearEl = document.getElementById('dash-academic-year');
                    if (acadYearEl) {
                        const yr = currentAcademicYear || studentProfile?.academicYear || selectedFeeAcademicYear || '';
                        acadYearEl.textContent = yr ? `Academic Year: ${yr}` : 'Academic Year: Current';
                    }
                    if (studentProfile && selectedFeeAcademicYear) {
                        availableAcademicYears = buildAvailableAcademicYears(studentProfile, allPayments, studentResultsCache);
                        if (!availableAcademicYears.includes(selectedFeeAcademicYear)) {
                            selectedFeeAcademicYear = (currentAcademicYear && availableAcademicYears.includes(currentAcademicYear))
                                ? currentAcademicYear
                                : availableAcademicYears[0];
                        }
                        if (!availableAcademicYears.includes(selectedResultAcademicYear)) {
                            selectedResultAcademicYear = (currentAcademicYear && availableAcademicYears.includes(currentAcademicYear))
                                ? currentAcademicYear
                                : availableAcademicYears[0];
                        }
                        renderStudentFeeDetails(studentProfile, selectedFeeAcademicYear);
                        renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                    }
                });

                try {
                    const academicYearDoc = await getDoc(doc(db, `${BASE_PATH}/settings`, 'academicYears'));
                    const academicData = academicYearDoc.exists() ? academicYearDoc.data() : {};
                    academicYearSettings = Array.isArray(academicData.years) ? academicData.years : academicYearSettings;
                    currentAcademicYear = academicData.currentYear || currentAcademicYear || '';
                } catch (yearError) {
                    console.warn('Unable to load academic year settings for student dashboard.', yearError);
                }

                try {
                    const grpSnap = await getDocs(collection(db, `${BASE_PATH}/studentGroups`));
                    studentGroups = grpSnap.docs.map(d => ({id: d.id, ...d.data()}));
                } catch (groupError) {
                    console.warn('Unable to load student groups for student dashboard.', groupError);
                    studentGroups = [];
                }

                const stuSnap = await getDoc(doc(db, `${BASE_PATH}/students`, studentId));
                if (!stuSnap.exists()) { alert("Student profile not found."); logoutStudent(); return; }
                const st = stuSnap.data();
                const activeGroup = studentGroups.find((group) => group.memberIds?.includes(studentId));
                if (activeGroup?.memberIds?.length) {
                    try {
                        const memberDocs = await Promise.all(activeGroup.memberIds.map((memberId) => getDoc(doc(db, `${BASE_PATH}/students`, memberId))));
                        groupMemberProfileMap = memberDocs.reduce((acc, memberDoc, idx) => {
                            if (memberDoc.exists()) acc[activeGroup.memberIds[idx]] = memberDoc.data();
                            return acc;
                        }, {});
                    } catch (memberError) {
                        console.warn('Unable to load group member profiles for student dashboard.', memberError);
                        groupMemberProfileMap = {};
                    }
                } else {
                    groupMemberProfileMap = {};
                }

                const [resultSchemaSnap, resultsSnap, staffSnap] = await Promise.allSettled([
                    getDocs(collection(db, `${BASE_PATH}/resultSchemas`)),
                    getDocs(query(collection(db, `${BASE_PATH}/examResults`), where('studentId', '==', studentId))),
                    getDocs(collection(db, `${BASE_PATH}/staff`))
                ]);
                const getSettledDocs = (settled, label) => {
                    if (settled.status === 'fulfilled') return settled.value.docs;
                    console.warn(`Unable to load ${label} for student dashboard.`, settled.reason);
                    return [];
                };
                try {
                    const resultCenterSnap = await getDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'));
                    resultCenterSettings = resultCenterSnap.exists() ? { blockedClasses: [], ...resultCenterSnap.data() } : { locked: false, blockedClasses: [] };
                } catch (resultCenterError) {
                    console.warn('Unable to load result center settings for student dashboard.', resultCenterError);
                    resultCenterSettings = { locked: false, blockedClasses: [] };
                }
                onSnapshot(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), (snap) => {
                    resultCenterSettings = snap.exists() ? { blockedClasses: [], ...snap.data() } : { locked: false, blockedClasses: [] };
                    if (studentProfile) {
                        renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                        rawResultAlerts = buildResultNotificationAlerts(studentProfile, studentResultsCache);
                        if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                    }
                });
                try {
                    const photoSubmissionSnap = await getDoc(doc(db, `${BASE_PATH}/studentPhotoSubmissions`, studentId));
                    studentPhotoSubmission = photoSubmissionSnap.exists() ? photoSubmissionSnap.data() : {};
                } catch (photoError) {
                    console.warn('Unable to load student photo submission state.', photoError);
                    studentPhotoSubmission = {};
                }
                resultSchemas = getSettledDocs(resultSchemaSnap, 'result schemas').map((d) => ({ id: d.id, ...d.data() }));
                allStaff = getSettledDocs(staffSnap, 'staff payment collectors').map((d) => d.data());
                const studentResults = getSettledDocs(resultsSnap, 'student results').map((d) => ({ id: d.id, ...d.data() })).filter((item) => item.published !== false);
                
                renderStudentComprehensiveProfile(st, studentPhotoSubmission);
                renderProfilePaymentDetails();
                setupStudentPhotoActions();
                setupStudentEditDetailsActions(studentId, st);
                setupStudentTopIdentityEdit(studentId, st);
                setupStudentQuickFieldEdit(studentId, st);
                const targetMemberIds = (activeGroup?.memberIds?.length && activeGroup.memberIds.length <= 10)
                    ? activeGroup.memberIds.filter(Boolean)
                    : [studentId];
                const payQuery = targetMemberIds.length > 1
                    ? query(collection(db, `${BASE_PATH}/payments`), where('studentId', 'in', targetMemberIds))
                    : query(collection(db, `${BASE_PATH}/payments`), where('studentId', '==', studentId));

                try {
                    const paySnap = await getDocs(payQuery);
                    const docs = paySnap.docs.map(d=>d.data());
                    allPayments = docs.filter(d => d.studentId === studentId);
                    siblingPayments = docs.filter(d => d.studentId !== studentId);
                } catch (paymentError) {
                    console.warn('Unable to load student payments for dashboard.', paymentError);
                    allPayments = [];
                    siblingPayments = [];
                }

                studentProfile = st;
                studentResultsCache = studentResults;
                classByYear[st.academicYear || '--'] = st.class || '--';
                studentResults.forEach((result) => {
                    if (result.academicYear && result.classLabel) classByYear[result.academicYear] = result.classLabel;
                });
                allPayments.forEach((payment) => {
                    if (payment.academicYear && (payment.classLabel || payment.class)) classByYear[payment.academicYear] = payment.classLabel || payment.class;
                });

                availableAcademicYears = buildAvailableAcademicYears(st, allPayments, studentResults);
                selectedFeeAcademicYear = (currentAcademicYear && availableAcademicYears.includes(currentAcademicYear))
                    ? currentAcademicYear
                    : availableAcademicYears[0];
                selectedResultAcademicYear = selectedFeeAcademicYear;

                document.getElementById('fee-year-select')?.addEventListener('change', (event) => {
                    selectedFeeAcademicYear = event.target.value;
                    renderStudentFeeDetails(studentProfile, selectedFeeAcademicYear);
                });
                document.getElementById('results-year-select')?.addEventListener('change', (event) => {
                    selectedResultAcademicYear = event.target.value;
                    renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                });
                document.getElementById('results-exam-select')?.addEventListener('change', () => {
                    renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                });

                renderStudentFeeDetails(studentProfile, selectedFeeAcademicYear);
                renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                syncResultTabVisibility(studentResultsCache.length > 0);
                rawResultAlerts = buildResultNotificationAlerts(studentProfile, studentResultsCache);
                if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();

                onSnapshot(query(collection(db, `${BASE_PATH}/examResults`), where('studentId', '==', studentId)), (snap) => {
                    studentResultsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((item) => item.published !== false);
                    availableAcademicYears = buildAvailableAcademicYears(studentProfile, allPayments, studentResultsCache);
                    renderStudentResults(studentProfile, studentResultsCache, selectedResultAcademicYear);
                    syncResultTabVisibility(studentResultsCache.length > 0);
                    rawResultAlerts = buildResultNotificationAlerts(studentProfile, studentResultsCache);
                    if(window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                });

                onSnapshot(payQuery, (paySnap) => {
                    const docs = paySnap.docs.map(d => ({ id: d.id, ...d.data() }));
                    allPayments = docs.filter(d => d.studentId === studentId);
                    siblingPayments = docs.filter(d => d.studentId !== studentId);
                    allPayments.forEach((payment) => {
                        if (payment.academicYear && (payment.classLabel || payment.class)) classByYear[payment.academicYear] = payment.classLabel || payment.class;
                    });
                    if (studentProfile) {
                        availableAcademicYears = buildAvailableAcademicYears(studentProfile, allPayments, studentResultsCache);
                        if (!selectedFeeAcademicYear || !availableAcademicYears.includes(selectedFeeAcademicYear)) {
                            selectedFeeAcademicYear = (currentAcademicYear && availableAcademicYears.includes(currentAcademicYear))
                                ? currentAcademicYear
                                : availableAcademicYears[0];
                        }
                        renderStudentFeeDetails(studentProfile, selectedFeeAcademicYear);
                        rawFeeAlerts = buildFeeNotificationAlerts(studentProfile);
                        if (window.triggerNotificationUpdate) window.triggerNotificationUpdate();
                    }
                });

                // Clean White Screen logic (Fade out instantly)
                const loader = document.getElementById('loading-screen');
                loader.style.opacity = '0';
                setTimeout(() => {
                    loader.style.display = 'none';
                    maybeShowStartupNotificationPrompt();
                    studentPwa.showPopupIfEligible();
                }, 300);

                // Automatically re-evaluate notifications when user opens/returns to the app on a new day
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible' && studentProfile) {
                        rawFeeAlerts = buildFeeNotificationAlerts(studentProfile);
                        renderNotificationPanel();
                    }
                });

            } catch (error) {
                console.error("Error loading dashboard:", error);
                const loader = document.getElementById('loading-screen');
                if (loader) loader.style.display = 'none';
                const resultsContainer = document.getElementById('results-container');
                if (resultsContainer && !resultsContainer.innerHTML.trim()) {
                    resultsContainer.innerHTML = buildEmptyState('Some dashboard data could not be loaded. Please refresh or contact office if this continues.', 'fa-exclamation-triangle');
                }
            }
        }

        onAuthStateChanged(auth, user => { if(user) { loadDashboardData(); } });
        window.AppSession?.touchSession();
        signInAnonymously(auth);
