using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KibangouTVDesktop
{
    static class Program
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static readonly string AppDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KibangouTV"
        );

        [STAThread]
        static void Main()
        {
            Directory.CreateDirectory(AppDataDir);
            ExtractResource("WebView2Loader.dll", Path.Combine(AppDataDir, "WebView2Loader.dll"));
            SetDllDirectory(AppDataDir);

            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
            {
                string shortName = new AssemblyName(args.Name).Name + ".dll";
                return LoadEmbeddedAssembly(shortName);
            };

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        private static void ExtractResource(string resName, string destPath)
        {
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resName))
                {
                    if (s == null) return;
                    if (!File.Exists(destPath) || new FileInfo(destPath).Length != s.Length)
                    {
                        using (FileStream fs = new FileStream(destPath, FileMode.Create, FileAccess.Write))
                        {
                            s.CopyTo(fs);
                        }
                    }
                }
            }
            catch { }
        }

        private static Assembly LoadEmbeddedAssembly(string resName)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resName))
            {
                if (s == null) return null;
                byte[] buf = new byte[s.Length];
                s.Read(buf, 0, buf.Length);
                return Assembly.Load(buf);
            }
        }
    }

    public class MainForm : Form
    {
        private WebView2 webView;
        private bool isFullscreen = false;
        private FormBorderStyle prevBorder;
        private FormWindowState prevState;

        public MainForm()
        {
            Text = "KibangouTV";
            Width = 1280;
            Height = 800;
            MinimumSize = new Size(800, 540);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(14, 19, 24);
            KeyPreview = true;

            webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(14, 19, 24)
            };
            Controls.Add(webView);
            Load += OnLoad;
            KeyDown += OnKeyDown;
        }

        private async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KibangouTV",
                    "WebView2Data"
                );
                var env = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(env);
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NewWindowRequested += (s, ev) =>
                {
                    ev.Handled = true;
                    webView.CoreWebView2.Navigate(ev.Uri);
                };
                webView.Source = new Uri("https://kibangoutv.vercel.app");
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Microsoft Edge WebView2 Runtime requis.\nErreur : " + ex.Message,
                    "KibangouTV",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11)
            {
                if (!isFullscreen)
                {
                    prevBorder = FormBorderStyle;
                    prevState = WindowState;
                    FormBorderStyle = FormBorderStyle.None;
                    WindowState = FormWindowState.Maximized;
                    isFullscreen = true;
                }
                else
                {
                    FormBorderStyle = prevBorder;
                    WindowState = prevState;
                    isFullscreen = false;
                }
            }
        }
    }
}
