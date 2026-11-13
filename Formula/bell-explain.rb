class BellExplain < Formula
  desc "Local-first interactive learning workspace for code, documents, and repositories"
  homepage "https://github.com/Suzu1Dev/BELL-Explain"
  url "https://github.com/Suzu1Dev/BELL-Explain/archive/refs/heads/main.tar.gz"
  version "1.0.1"
  license "Apache-2.0"
  head "https://github.com/Suzu1Dev/BELL-Explain.git", branch: "main"

  depends_on "node"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bell-explain --version")
    assert_match "doctor", shell_output("#{bin}/bell-explain --help")
  end
end
