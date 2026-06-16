{
  "targets": [
    {
      "target_name": "winaudio",
      "sources": [ "src/winaudio.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS", "NOMINMAX", "WIN32_LEAN_AND_MEAN" ],
      "conditions": [
        ["OS==\"win\"", {
          "libraries": [
            "-lole32.lib",
            "-loleaut32.lib",
            "-lmmdevapi.lib",
            "-lavrt.lib",
            "-lksuser.lib",
            "-luuid.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
