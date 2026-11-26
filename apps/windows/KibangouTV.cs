using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace KibangouTVDesktop
{
    static class Program
    {
        private const string AppUrl = "https://kibangoutv.vercel.app";

        [STAThread]
        static void Main()
        {
            string[] edgeCandidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
            };

            foreach (string exe in edgeCandidates)
            {
                if (File.Exists(exe))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exe,
                        Arguments = "--app=" + AppUrl + " --class=KibangouTV --window-size=1280,800",
                        UseShellExecute = true
                    });
                    return;
                }
            }

            string[] chromeCandidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe")
            };

            foreach (string exe in chromeCandidates)
            {
                if (File.Exists(exe))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exe,
                        Arguments = "--app=" + AppUrl,
                        UseShellExecute = true
                    });
                    return;
                }
            }

            try
            {
                Process.Start(new ProcessStartInfo { FileName = AppUrl, UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Impossible d'ouvrir KibangouTV : " + ex.Message, "KibangouTV", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
