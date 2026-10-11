%global __os_install_post %{nil}
%global debug_package %{nil}

Name:           factory-desktop-linux
Version:        0.194.0
Release:        7%{?dist}
Summary:        Unofficial personal-use Factory Desktop port
License:        LicenseRef-Proprietary
BuildArch:      x86_64

Source0:        PERSONAL-USE-NOTICE.txt
Source1:        factory.desktop
Source2:        factory-desktop-linux
Source3:        factory-desktop-linux-icon

%description
Unofficial personal-use port of Factory Desktop 0.194.0 for Fedora 44 x86_64.
This proprietary application is not produced, endorsed, or supported by
Factory. The RPM is for personal use only and must not be published.

%prep

%build

%install
mkdir -p "%{buildroot}/opt"
cp -a "%{_sourcedir}/payload" "%{buildroot}/opt/factory-desktop-linux"
find "%{buildroot}/opt/factory-desktop-linux" -type d -exec chmod 0755 {} +
install -D -m 0755 "%{SOURCE2}" "%{buildroot}/usr/bin/factory-desktop-linux"
install -D -m 0644 "%{SOURCE1}" "%{buildroot}/usr/share/applications/factory.desktop"
install -D -m 0644 "%{SOURCE0}" "%{buildroot}/usr/share/licenses/%{name}/PERSONAL-USE-NOTICE.txt"
install -D -m 0644 "%{SOURCE3}" "%{buildroot}/usr/share/icons/hicolor/%{app_icon_size}/apps/factory-desktop-linux.%{app_icon_extension}"

%files
%defattr(-,root,root,-)
/opt/factory-desktop-linux/
/usr/bin/factory-desktop-linux
/usr/share/applications/factory.desktop
%{_datadir}/icons/hicolor/%{app_icon_size}/apps/factory-desktop-linux.%{app_icon_extension}
%license %{_licensedir}/%{name}/PERSONAL-USE-NOTICE.txt

%changelog
* Sat Oct 10 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-7
- Bundle the official Linux Droid CLI 0.238.0 with Desktop 0.194.0
- Preserve integrated header patches and pin the CLI package integrity

* Fri Oct 09 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-6
- Integrate theme-aware window controls and menus into the app header
- Keep Alt and F10 menu access and align controls with app zoom

* Fri Oct 09 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-5
- Restore Fedora native title bar and window controls

* Fri Oct 09 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-4
- Verify packaged desktop integration scripts against the build manifest
- Allow Fedora to report the new desktop entry as its effective handler

* Fri Oct 09 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-3
- Allow Fedora to report the new desktop entry as its effective handler

* Fri Oct 09 2026 Factory Desktop Linux Port <noreply@example.invalid> - 0.194.0-2
- Make installed app directories readable to normal users
- Support callback registration after the app creates its state directory
