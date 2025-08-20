# Language Switching Debug Guide

## Issue: Spanish Selection Not Working

The issue you're experiencing where selecting Spanish doesn't change the interface language is likely due to one of these reasons:

## 🔍 Most Likely Causes:

### 1. **App Needs Restart** (Most Common)
The new Spanish translation files need to be loaded by the development server.

**Solution:**
```bash
# Stop the current dev server (Ctrl+C)
# Then restart it
bun run dev
```

### 2. **Translation Files Not Loaded**
The new Spanish translation files might not be properly imported.

**Check in Browser Console:**
- Open browser dev tools (F12)
- Look for console messages starting with 🌐
- Should see: "i18n initialized successfully" and available languages

### 3. **Build Cache Issue**
Sometimes the build system caches old files.

**Solution:**
```bash
# Clear any build cache
rm -rf node_modules/.vite
bun run dev
```

## 🧪 Testing Steps:

### Step 1: Check Console Logs
1. Open browser dev tools (F12)
2. Go to Console tab
3. Look for these messages:
   ```
   🌐 i18n initialized successfully
   🌐 Available languages: ['en', 'es']
   🌐 Current language: en
   ```

### Step 2: Test Language Switching
1. Go to Settings → General → Language Settings
2. Change from English to Español
3. Check console for:
   ```
   🌐 Language changing to: es
   🌐 Available languages: {en: {...}, es: {...}}
   🌐 Language changed successfully to: es
   ```

### Step 3: Verify Translation
After selecting Spanish, you should see:
- "General Settings" → "Configuración General"
- "Display Language" → "Idioma de visualización"
- "Primary Currency" → "Moneda principal"

## 🔧 If Still Not Working:

### Check 1: Verify Files Exist
```bash
ls -la src/i18n/locales/es/
# Should show: common.json, settings.json, wallet.json, etc.
```

### Check 2: Verify Translation Content
```bash
cat src/i18n/locales/es/settings.json | grep "title"
# Should show: "title": "Configuración",
```

### Check 3: Manual Language Test
In browser console, try:
```javascript
// Check if Spanish is loaded
window.i18n?.store?.data?.es
// Should show Spanish translations

// Manually change language
window.i18n?.changeLanguage('es')
```

## 🎯 Expected Behavior:

### Before Fix:
- Language dropdown shows but doesn't change interface
- Console might show language not found errors
- Interface stays in English

### After Fix:
- Selecting "Español" immediately changes interface text
- "Settings" becomes "Configuración"
- Console shows successful language change
- Language preference persists on refresh

## 🐛 Troubleshooting Commands:

### 1. Restart Dev Server
```bash
# Kill current server
# Ctrl+C or Cmd+C

# Start fresh
bun run dev
```

### 2. Clear All Caches
```bash
# Clear bun cache
bun pm cache rm

# Clear node modules
rm -rf node_modules
bun install

# Start dev server
bun run dev
```

### 3. Check Translation Loading
In browser console:
```javascript
// Check what languages are available
console.log(Object.keys(window.i18n?.store?.data || {}))

// Check Spanish translations specifically
console.log(window.i18n?.store?.data?.es?.settings?.title)
// Should output: "Configuración"
```

## 🎉 Success Indicators:

When working correctly, you should see:
1. ✅ Console shows "🌐 i18n initialized successfully"
2. ✅ Available languages includes both 'en' and 'es'
3. ✅ Selecting Spanish changes visible text immediately
4. ✅ Settings dialog title changes to "Configuración"
5. ✅ Language preference saves and persists on refresh

## 📝 Files Changed:

The following files were modified to add Spanish support:
- `src/i18n/index.ts` - Added Spanish imports and resources
- `src/i18n/locales/es/*.json` - New Spanish translation files
- `src/components/LanguageSwitcher.tsx` - Added debug logging
- `src/components/SettingsDialog.tsx` - Fixed translation keys

## 🚀 Next Steps:

Once Spanish is working:
1. Test all translated components
2. Add more languages (French, German, etc.)
3. Expand Spanish translations to cover more components
4. Remove debug logging for production

The most likely fix is simply restarting the development server to load the new translation files!