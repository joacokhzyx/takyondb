// TEMPORARY CI diagnostic (to be removed once the macOS shm_open EACCES
// puzzle is solved): distinguishes "the OS denies reopen" from "Zig's std
// misbehaves" by exercising raw libc shm_open directly.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
    const char *n = "/takyon_probe";
    shm_unlink(n);

    errno = 0;
    int fd = shm_open(n, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("create fd=%d errno=%d (%s)\n", fd, errno, fd < 0 ? strerror(errno) : "ok");
    if (fd >= 0) {
        if (ftruncate(fd, 16777216) != 0) printf("ftruncate errno=%d (%s)\n", errno, strerror(errno));
        close(fd);
    }

    errno = 0;
    int fd2 = shm_open(n, O_RDWR, 0666);
    printf("reopen-rw fd=%d errno=%d (%s)\n", fd2, errno, fd2 < 0 ? strerror(errno) : "ok");
    if (fd2 >= 0) close(fd2);

    errno = 0;
    int fd3 = shm_open(n, O_RDONLY, 0666);
    printf("reopen-ro fd=%d errno=%d (%s)\n", fd3, errno, fd3 < 0 ? strerror(errno) : "ok");
    if (fd3 >= 0) close(fd3);

    shm_unlink(n);

    // Discriminant: does ftruncate change reopen behavior?
    const char *m = "/takyon_probe_trunc";
    shm_unlink(m);
    errno = 0;
    int t1 = shm_open(m, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("trunc-create fd=%d errno=%d (%s)\n", t1, errno, t1 < 0 ? strerror(errno) : "ok");
    if (t1 >= 0) {
        if (ftruncate(t1, 16777216) != 0) printf("trunc-ftruncate errno=%d (%s)\n", errno, strerror(errno));
        close(t1);
    }
    errno = 0;
    int t2 = shm_open(m, O_RDWR, 0666);
    printf("trunc-reopen fd=%d errno=%d (%s)\n", t2, errno, t2 < 0 ? strerror(errno) : "ok");
    if (t2 >= 0) close(t2);
    shm_unlink(m);

    // Mirror the unit-test lifecycle exactly: create, size, mmap shared+w,
    // write, munmap, close, then reopen (the tests fail this reopen).
    const char *q = "/takyon_probe_life";
    shm_unlink(q);
    errno = 0;
    int q1 = shm_open(q, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("life-create fd=%d errno=%d (%s)\n", q1, errno, q1 < 0 ? strerror(errno) : "ok");
    if (q1 >= 0) {
        ftruncate(q1, 16777216);
        void *mp = mmap(NULL, 16777216, PROT_READ | PROT_WRITE, MAP_SHARED, q1, 0);
        printf("life-mmap ptr=%p errno=%d (%s)\n", mp, errno, mp == MAP_FAILED ? strerror(errno) : "ok");
        if (mp != MAP_FAILED) {
            ((volatile unsigned char *)mp)[8192] = 0x5A;
            munmap(mp, 16777216);
        }
        close(q1);
    }
    errno = 0;
    int q2 = shm_open(q, O_RDWR, 0666);
    printf("life-reopen fd=%d errno=%d (%s)\n", q2, errno, q2 < 0 ? strerror(errno) : "ok");
    if (q2 >= 0) close(q2);
    shm_unlink(q);

    // Replicate the engine fallback sequence exactly: O_EXCL|O_CREAT on an
    // EXISTING object (expect EEXIST), then immediate plain reopen.
    const char *f = "/takyon_probe_fb";
    shm_unlink(f);
    int f0 = shm_open(f, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("fb-create fd=%d errno=%d (%s)\n", f0, errno, f0 < 0 ? strerror(errno) : "ok");
    if (f0 >= 0) close(f0);
    errno = 0;
    int f1 = shm_open(f, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("fb-excl fd=%d errno=%d (%s)\n", f1, errno, f1 < 0 ? strerror(errno) : "ok");
    if (f1 >= 0) close(f1);
    errno = 0;
    int f2 = shm_open(f, O_RDWR, 0666);
    printf("fb-fallback fd=%d errno=%d (%s)\n", f2, errno, f2 < 0 ? strerror(errno) : "ok");
    if (f2 >= 0) close(f2);
    shm_unlink(f);
    return 0;
}
