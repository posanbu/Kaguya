# MaiBot GoCQ Adapter Documentation

An older framework; some accounts may have a lower risk control probability on this framework.

## GoCQ Configuration

### Installing GoCQ

First, you need to install GoCQ itself. Below are some different GoCQ versions:
[AstralGocq](https://github.com/ProtocolScience/AstralGocq)
[gocq-http(New)](https://github.com/LagrangeDev/go-cqhttp)
Download the corresponding version from the release page of these projects. This guide only provides installation instructions for the Windows version.

### Configuring GoCQ

After downloading, extract the executable file into a folder.

Double-click to open the GoCQ main program. A prompt will appear asking you to generate a secure startup script. Click "Confirm" to generate the startup script.

Close the GoCQ main program, then use the secure startup script to launch GoCQ. At this point, you will be prompted to select a connection method. Choose `Reverse WebSocket`. After the `config.yml` configuration file is generated, close the window.

Open `config.yml` and modify the following settings:

::: code-group

```yaml [YAML ~vscode-icons:file-type-yaml-official~]
# List of connection services
servers:
  # Add methods; multiple entries with the same method are allowed. For detailed configuration instructions, refer to the documentation.
  #- http: # HTTP communication
  #- ws:   # Forward Websocket
  #- ws-reverse: # Reverse Websocket
  #- pprof: # Performance analysis server
  # Reverse WS settings
  - ws-reverse:
      # Reverse WS Universal address
      # Note: After setting this address, the following two items will be ignored.
      universal: ws://127.0.0.1:8095
      # Reverse WS API address
      api: ws://your_websocket_api.server
      # Reverse WS Event address
      event: ws://your_websocket_event.server
      # Reconnection interval (unit: milliseconds)
      reconnect-interval: 3000
      middlewares:
        <<: *default # Reference default middleware
```

:::

Use the startup script to launch GoCQ and perform QR code login.

If verification is required, open the provided link in a browser, press F12 to open the Developer Tools, navigate to the Network (or Network) tab, and complete the verification normally. After verification is complete, wait a few seconds. A success message will appear. In your Developer Tools, click the last request, open the response, copy the value of the `ticket` field, paste it into the gocq input box, and press Enter to complete the verification.

## GoCQ Adapter Configuration

### Installing GoCQ Adapter

Clone the [repository](https://github.com/LOGIC-SC/MaiBot-Gocq-Adapter.git) from GitHub, install dependencies, and then start it using the appropriate environment.

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
git clone https://github.com/LOGIC-SC/MaiBot-Gocq-Adapter.git
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple --upgrade
python main.py
```

:::

### Configuring GoCQ Adapter

This Go-CQ Adapter is a secondary modification based on the Napcat Adapter, and its configuration is similar. Therefore, it will not be elaborated here.

Warning: Unlike the Napcat Adapter, the `Napcat_server` item here has been replaced with `gocq_server` after following updates to the Napcat Adapter. When upgrading from an older version to a newer version, be sure to modify the configuration accordingly.