import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDdUyk_yvZoQ1JI1pPLJTK51U91BVO0XSA",
  authDomain: "bright-tube-p07pf.firebaseapp.com",
  projectId: "bright-tube-p07pf",
  storageBucket: "bright-tube-p07pf.firebasestorage.app",
  messagingSenderId: "239455260650",
  appId: "1:239455260650:web:5c3d61cbd8fcfefccc6c93",
  firestoreDatabaseId: "ai-studio-feee-81b4709b-982c-4f96-b21b-c346855b9aa2"
};

const app = initializeApp(firebaseConfig);

const appCheckSiteKey = String(window.__APP_CHECK_SITE_KEY || '').trim();
const canEnableAppCheck = appCheckSiteKey && appCheckSiteKey !== 'REPLACE_WITH_RECAPTCHA_V3_SITE_KEY';
const appCheck = canEnableAppCheck
  ? initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    })
  : null;

if (!canEnableAppCheck) {
  console.warn('[Security] App Check is not enabled yet: set window.__APP_CHECK_SITE_KEY with a valid reCAPTCHA v3 site key.');
}

const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

export { db, auth, appCheck, canEnableAppCheck };
