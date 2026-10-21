{
  "targets": [
    {
      "target_name": "shellmenu",
      "sources": ["src/shellmenu.cc"],
      "include_dirs": ["../../node_modules/node-addon-api"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "libraries": ["shell32.lib", "shlwapi.lib", "ole32.lib", "user32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
