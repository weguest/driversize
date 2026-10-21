// Native Windows shell context menu (IContextMenu) for the Electron main process.
// Shows the classic Explorer context menu, including third-party verbs (7-Zip, ...).
#include <napi.h>

#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>

#include <string>
#include <vector>
#include <cstdio>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")

static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], len);
  return w;
}

static std::wstring ToLower(std::wstring s) {
  for (auto& c : s) c = (wchar_t)towlower(c);
  return s;
}

static std::wstring DirNameOf(const std::wstring& p) {
  size_t i = p.find_last_of(L"\\/");
  if (i == std::wstring::npos) return p;
  if (i == 2 && p[1] == L':') return p.substr(0, 3);  // "C:\"
  return p.substr(0, i);
}

// showContextMenu(hwndBuffer, paths[]) -> boolean
static Napi::Value ShowContextMenu(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsArray()) {
    return Napi::Boolean::New(env, false);
  }

  // HWND from the Electron window handle buffer (pointer-sized).
  uintptr_t raw = 0;
  {
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    const uint8_t* d = buf.Data();
    size_t n = buf.Length();
    if (n >= sizeof(void*)) memcpy(&raw, d, sizeof(void*));
  }
  HWND hwnd = (HWND)raw;

  Napi::Array arr = info[1].As<Napi::Array>();
  std::vector<std::wstring> paths;
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    if (!arr.Get(i).IsString()) continue;
    paths.push_back(Utf8ToWide(arr.Get(i).As<Napi::String>().Utf8Value()));
  }
  if (paths.empty()) return Napi::Boolean::New(env, false);

  // The Windows menu follows the thread UI language; the process runs in en-US by
  // default, so pin the menu to the language Windows itself uses.
  SetThreadUILanguage(GetSystemDefaultUILanguage());
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  bool needUninit = SUCCEEDED(hr);
  const std::wstring parentDir = DirNameOf(paths[0]);
  const std::wstring parentKey = ToLower(parentDir);

  std::vector<PIDLIST_ABSOLUTE> absPidls;  // kept alive until InvokeCommand
  std::vector<PCUITEMID_CHILD> children;   // relative to psfParent
  IShellFolder* psfParent = nullptr;

  for (const auto& p : paths) {
    if (ToLower(DirNameOf(p)) != parentKey) continue;  // only same-folder items
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (FAILED(SHParseDisplayName(p.c_str(), nullptr, &pidl, 0, nullptr)) || !pidl) continue;
    IShellFolder* psf = nullptr;
    PCUITEMID_CHILD child = nullptr;
    if (SUCCEEDED(SHBindToParent(pidl, IID_IShellFolder, (void**)&psf, &child)) && psf && child) {
      if (!psfParent) psfParent = psf;  // keep first
      else psf->Release();
      children.push_back(child);
    }
    absPidls.push_back(pidl);  // free later
  }

  bool invoked = false;
  if (psfParent && !children.empty()) {
    IContextMenu* pcm = nullptr;
    hr = psfParent->GetUIObjectOf(hwnd, (UINT)children.size(), children.data(), IID_IContextMenu, nullptr, (void**)&pcm);
    if (SUCCEEDED(hr) && pcm) {
      HMENU hMenu = CreatePopupMenu();
      if (hMenu &&
          SUCCEEDED(pcm->QueryContextMenu(hMenu, 0, 1, 0x7FFF, CMF_NORMAL | CMF_EXTENDEDVERBS))) {
        POINT pt;
        GetCursorPos(&pt);
        // TrackPopupMenu requires a foreground owner: without it the menu can be
        // dismissed right away when the window is not active.
        SetForegroundWindow(hwnd);
        int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, nullptr);
        PostMessage(hwnd, WM_NULL, 0, 0);
        if (cmd > 0) {
          CMINVOKECOMMANDINFOEX ici;
          ZeroMemory(&ici, sizeof(ici));
          ici.cbSize = sizeof(ici);
          ici.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE;
          ici.hwnd = hwnd;
          ici.lpVerb = MAKEINTRESOURCEA(cmd - 1);
          ici.lpVerbW = MAKEINTRESOURCEW(cmd - 1);
          ici.nShow = SW_SHOWNORMAL;
          ici.ptInvoke = pt;
          pcm->InvokeCommand((LPCMINVOKECOMMANDINFO)&ici);
          invoked = true;
        }
      }
      if (hMenu) DestroyMenu(hMenu);
      pcm->Release();
    }
  }

  if (psfParent) psfParent->Release();
  for (auto p : absPidls) CoTaskMemFree(p);
  if (needUninit) CoUninitialize();

  return Napi::Boolean::New(env, invoked);
}

// dumpMenu(path) -> ["Abrir", ..., "Formatar...", "Propriedades"]  (diagnostics only)
static Napi::Value DumpMenu(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  if (info.Length() < 1 || !info[0].IsString()) return out;
  SetThreadUILanguage(GetSystemDefaultUILanguage());
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  bool needUninit = SUCCEEDED(hrInit);
  const std::wstring p = Utf8ToWide(info[0].As<Napi::String>().Utf8Value());

  PIDLIST_ABSOLUTE pidl = nullptr;
  if (FAILED(SHParseDisplayName(p.c_str(), nullptr, &pidl, 0, nullptr)) || !pidl) {
    if (needUninit) CoUninitialize();
    return out;
  }
  IShellFolder* psf = nullptr;
  PCUITEMID_CHILD child = nullptr;
  IContextMenu* pcm = nullptr;
  HMENU h = nullptr;
  HRESULT hrBind = SHBindToParent(pidl, IID_IShellFolder, (void**)&psf, &child);
  HRESULT hrObj = (SUCCEEDED(hrBind) && psf && child)
                      ? psf->GetUIObjectOf(GetDesktopWindow(), 1, &child, IID_IContextMenu, nullptr, (void**)&pcm)
                      : E_FAIL;
  if (SUCCEEDED(hrObj) && pcm) {
    h = CreatePopupMenu();
    if (h && SUCCEEDED(pcm->QueryContextMenu(h, 0, 1, 0x7FFF, CMF_NORMAL | CMF_EXTENDEDVERBS))) {
      uint32_t k = 0;
      const int n = GetMenuItemCount(h);
      for (int i = 0; i < n; i++) {
        wchar_t buf[512] = {0};
        if (GetMenuStringW(h, i, buf, 512, MF_BYPOSITION) <= 0) continue;
        int len = WideCharToMultiByte(CP_UTF8, 0, buf, -1, nullptr, 0, nullptr, nullptr);
        std::string t;
        if (len > 1) {
          t.resize((size_t)len - 1);
          WideCharToMultiByte(CP_UTF8, 0, buf, -1, &t[0], len, nullptr, nullptr);
        }
        out.Set(k++, Napi::String::New(env, t));
      }
    }
  }
  if (h) DestroyMenu(h);
  if (pcm) pcm->Release();
  if (psf) psf->Release();
  CoTaskMemFree(pidl);
  if (needUninit) CoUninitialize();
  return out;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("showContextMenu", Napi::Function::New(env, ShowContextMenu));
  exports.Set("dumpMenu", Napi::Function::New(env, DumpMenu));
  return exports;
}

NODE_API_MODULE(shellmenu, Init)
