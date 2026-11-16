# Security

Please report vulnerabilities privately with **Report a vulnerability** on this repository's Security tab, not
in a public issue. You'll get a reply within a few days.

Designlane runs on your machine and only reads the project you point it at. These are bugs worth reporting:

- Reading a file outside the project, including through a symlink
- Writing anywhere other than Designlane's own output folder
- A generated page that can run script or reach the network
