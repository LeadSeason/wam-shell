
## Avatar
Avatar should be located in 
/var/lib/AccountsService/icons/<user>

https://wiki.archlinux.org/title/KDE#Faces

```
busctl call \
    org.freedesktop.Accounts \
    /org/freedesktop/Accounts/User$uid \
    org.freedesktop.Accounts.User \
    SetIconFile \
    s /path/to/image.p
```
Maybe pick that up and use it?